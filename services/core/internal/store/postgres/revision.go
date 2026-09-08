package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

func materializeTopologyRevision(ctx context.Context, tx pgx.Tx, environment, sourceRunID string) (string, bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT item FROM (
		  SELECT 'e:' || e.entity_id AS item
		  FROM canonical_entity e
		  WHERE e.environment=$1
		    AND EXISTS (SELECT 1 FROM semantic_assertion a WHERE a.entity_id=e.entity_id AND a.valid_to IS NULL)
		  UNION ALL
		  SELECT 'r:' || r.relation_id AS item
		  FROM canonical_relation r
		  JOIN canonical_entity src ON src.entity_id=r.source_entity_id
		  JOIN canonical_entity dst ON dst.entity_id=r.target_entity_id
		  WHERE src.environment=$1 AND dst.environment=$1
		    AND EXISTS (SELECT 1 FROM semantic_assertion a WHERE a.relation_id=r.relation_id AND a.valid_to IS NULL)
		    AND EXISTS (SELECT 1 FROM semantic_assertion a WHERE a.entity_id=r.source_entity_id AND a.valid_to IS NULL)
		    AND EXISTS (SELECT 1 FROM semantic_assertion a WHERE a.entity_id=r.target_entity_id AND a.valid_to IS NULL)
		) active_graph
		ORDER BY item`, environment)
	if err != nil {
		return "", false, fmt.Errorf("read active graph: %w", err)
	}
	defer rows.Close()
	items := []string{}
	entityCount, relationCount := 0, 0
	for rows.Next() {
		var item string
		if err := rows.Scan(&item); err != nil {
			return "", false, err
		}
		items = append(items, item)
		if strings.HasPrefix(item, "e:") {
			entityCount++
		} else if strings.HasPrefix(item, "r:") {
			relationCount++
		}
	}
	if err := rows.Err(); err != nil {
		return "", false, err
	}
	h := sha256.Sum256([]byte(strings.Join(items, "\n")))
	graphHash := hex.EncodeToString(h[:])

	var latestID, latestHash string
	err = tx.QueryRow(ctx, `
		SELECT revision_id, graph_hash FROM topology_revision
		WHERE environment=$1 ORDER BY created_at DESC, revision_id DESC LIMIT 1`, environment).Scan(&latestID, &latestHash)
	if err != nil && err != pgx.ErrNoRows {
		return "", false, err
	}
	if err == nil && latestHash == graphHash {
		return latestID, false, nil
	}
	revisionID := hashID("rev_", environment, graphHash, sourceRunID)
	_, err = tx.Exec(ctx, `
		INSERT INTO topology_revision(revision_id, environment, reason, source_run_id, graph_hash, entity_count, relation_count, metadata)
		VALUES($1,$2,'source_run_ingest',$3,$4,$5,$6,$7::jsonb)
		ON CONFLICT(revision_id) DO NOTHING`, revisionID, environment, sourceRunID, graphHash, entityCount, relationCount,
		jsonString(map[string]interface{}{"active_graph_items": len(items)}))
	if err != nil {
		return "", false, fmt.Errorf("insert topology revision: %w", err)
	}
	return revisionID, true, nil
}
