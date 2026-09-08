package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/compat"
	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/internal/store"
	"github.com/alajmah/mw-dashboard-core/registry"
)

type Server struct {
	repo        store.Repository
	registry    *registry.Registry
	ingestToken string
	mux         *http.ServeMux
}

func New(repo store.Repository, reg *registry.Registry, ingestToken string) *Server {
	s := &Server{repo: repo, registry: reg, ingestToken: ingestToken, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return securityHeaders(s.mux) }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /health", s.health)
	s.mux.HandleFunc("GET /v2/registry", s.getRegistry)
	s.mux.HandleFunc("GET /v2/entities", s.listEntities)
	s.mux.HandleFunc("POST /v2/ingest", s.requireIngestAuth(s.ingestBundle))
	s.mux.HandleFunc("POST /v2/compat/topology", s.requireIngestAuth(s.ingestLegacyTopology))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireIngestAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimSpace(s.ingestToken) == "" {
			writeError(w, http.StatusServiceUnavailable, "ingest is disabled because INGEST_TOKEN is not configured")
			return
		}
		auth := strings.TrimSpace(r.Header.Get("Authorization"))
		if !strings.HasPrefix(auth, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")) != s.ingestToken {
			w.Header().Set("WWW-Authenticate", `Bearer realm="mw-dashboard-core"`)
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]interface{}{"error": message, "status": status})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst interface{}) error {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra interface{}
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request must contain exactly one JSON document")
		}
		return err
	}
	return nil
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.repo.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{"status": "degraded", "database": "unavailable", "detail": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "database": "ok", "registry": s.registry.SchemaVersion, "time": time.Now().UTC()})
}

func (s *Server) getRegistry(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.registry)
}

func (s *Server) listEntities(w http.ResponseWriter, r *http.Request) {
	environment := strings.TrimSpace(r.URL.Query().Get("environment"))
	if environment == "" {
		environment = "default"
	}
	entityType := strings.TrimSpace(r.URL.Query().Get("type"))
	if entityType != "" {
		if _, ok := s.registry.EntityDefinition(entityType); !ok {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown entity type %q", entityType))
			return
		}
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil {
			limit = v
		}
	}
	items, err := s.repo.ListEntities(r.Context(), environment, entityType, q, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"environment": environment, "items": items, "count": len(items)})
}

func (s *Server) ingestBundle(w http.ResponseWriter, r *http.Request) {
	var bundle domain.ObservationBundle
	if err := decodeJSON(w, r, &bundle); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := s.registry.ValidateBundle(bundle); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	result, err := s.repo.IngestBundle(r.Context(), bundle, s.registry)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) ingestLegacyTopology(w http.ResponseWriter, r *http.Request) {
	var legacy compat.LegacyTopology
	if err := decodeJSON(w, r, &legacy); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	bundle, err := compat.ConvertLegacyTopology(legacy, time.Now().UTC())
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if err := s.registry.ValidateBundle(bundle); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "compatibility conversion failed semantic validation: "+err.Error())
		return
	}
	result, err := s.repo.IngestBundle(r.Context(), bundle, s.registry)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{"compatibility_source": "topology-v1", "result": result})
}
