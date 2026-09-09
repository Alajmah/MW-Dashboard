# Canonical Overview and Explore data plane

This slice moves the default Overview and Explore screens from the legacy full-graph snapshot to the current canonical semantic estate.

## Default load

The initial page loads only:

- `/shell.js`
- `/estate-ui.js`
- canonical estate summary
- bounded canonical queue-manager / instance / host context

The legacy `app.js`, `routes-v2.js`, and inventory-v2 modules are not executed on initial load.

## Overview

Overview reads the canonical estate and displays:

- canonical entity and relationship counts
- active semantic source count
- logical queue managers
- physical hosts
- unresolved evidence counts
- canonical identity states
- queue-manager physical placement from `has_instance` → `runs_on`

Network endpoints are never promoted to physical hosts.

## Explore

Explore uses server-side pagination and filtering over `/api/v2/estate/current/entities`.

Supported filters:

- search query
- semantic type
- identity state
- page size (25, 50, 100)

Each row shows logical ownership and current / observed physical server where that placement can be proven from canonical relations. Unknown placement remains explicit.

## Legacy views

Servers, Middleware, Applications, Routes, Snapshots, and Administration are lazy-loaded from the legacy client only when opened. Routes additionally lazy-loads its legacy route module on first use.

This is transitional. The next slices migrate Routes and the remaining domain-specific screens onto canonical semantic query APIs.
