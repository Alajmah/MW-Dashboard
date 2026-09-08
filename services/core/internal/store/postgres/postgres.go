package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Repository, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres pool: %w", err)
	}
	r := &Repository{pool: pool}
	if err := r.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return r, nil
}

func (r *Repository) Close() { r.pool.Close() }

func (r *Repository) Ping(ctx context.Context) error {
	if err := r.pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres ping: %w", err)
	}
	return nil
}

func hashID(prefix string, parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return prefix + hex.EncodeToString(h[:])[:24]
}

func contentHash(bundle domain.ObservationBundle) (string, error) {
	b, err := json.Marshal(bundle)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func jsonString(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func nullIfEmpty(v string) interface{} {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

func artifactFields(a *domain.ArtifactRef) (uri, sum, media string, size *int64) {
	if a == nil {
		return "", "", "", nil
	}
	if a.SizeBytes != 0 {
		s := a.SizeBytes
		size = &s
	}
	return a.URI, a.SHA256, a.MediaType, size
}

func (r *Repository) ListEntities(ctx context.Context, environment, entityType, query string, limit int) ([]domain.EntitySummary, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	args := []interface{}{environment}
	where := []string{"environment=$1", "EXISTS (SELECT 1 FROM semantic_assertion active WHERE active.entity_id=canonical_entity.entity_id AND active.valid_to IS NULL)"}
	if entityType != "" {
		args = append(args, entityType)
		where = append(where, fmt.Sprintf("entity_type=$%d", len(args)))
	}
	if query != "" {
		args = append(args, "%"+query+"%")
		where = append(where, fmt.Sprintf("(display_name ILIKE $%d OR attributes::text ILIKE $%d)", len(args), len(args)))
	}
	args = append(args, limit)
	q := fmt.Sprintf(`SELECT entity_id, entity_type, environment, logical_key, display_name, COALESCE(status,''), attributes, first_seen_at, last_seen_at
		FROM canonical_entity WHERE %s ORDER BY entity_type, display_name LIMIT $%d`, strings.Join(where, " AND "), len(args))
	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.EntitySummary{}
	for rows.Next() {
		var item domain.EntitySummary
		var attrs []byte
		if err := rows.Scan(&item.ID, &item.Type, &item.Environment, &item.LogicalKey, &item.DisplayName, &item.Status, &attrs, &item.FirstSeenAt, &item.LastSeenAt); err != nil {
			return nil, err
		}
		if len(attrs) > 0 {
			_ = json.Unmarshal(attrs, &item.Attributes)
		}
		if item.Attributes == nil {
			item.Attributes = map[string]interface{}{}
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
