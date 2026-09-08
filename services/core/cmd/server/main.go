package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/httpapi"
	"github.com/alajmah/mw-dashboard-core/internal/store/postgres"
	"github.com/alajmah/mw-dashboard-core/registry"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	reg, err := registry.LoadDefault()
	if err != nil {
		logger.Error("load semantic registry", "error", err)
		os.Exit(1)
	}

	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	repo, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		logger.Error("open semantic database", "error", err)
		os.Exit(1)
	}
	defer repo.Close()

	addr := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if addr == "" {
		addr = ":8080"
	}
	api := httpapi.New(repo, reg, os.Getenv("INGEST_TOKEN"))
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       35 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	go func() {
		logger.Info("mw-dashboard core listening", "addr", addr, "registry", reg.SchemaVersion)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server failed", "error", err)
			cancel()
		}
	}()

	<-ctx.Done()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("http shutdown", "error", err)
	}
}
