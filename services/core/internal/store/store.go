package store

import (
	"context"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/registry"
)

type Repository interface {
	Ping(ctx context.Context) error
	IngestBundle(ctx context.Context, bundle domain.ObservationBundle, reg *registry.Registry) (domain.IngestResult, error)
	ListEntities(ctx context.Context, environment, entityType, query string, limit int) ([]domain.EntitySummary, error)
}
