import { Injectable } from '@nestjs/common';
import type { TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';

export interface TerritoryInput {
  code: string;
  name: string;
  territoryType: 'REGION' | 'AREA' | 'TERRITORY';
  parentId?: string | null;
  teamId?: string | null;
  isActive?: boolean;
}

export interface LocationImportRow {
  level: 'COUNTRY' | 'REGION' | 'PROVINCE' | 'DISTRICT' | 'COMMUNE' | 'VILLAGE';
  code: string;
  name: string;
  nameLocal?: string;
  parentCode?: string;
  parentLevel?: LocationImportRow['level'];
  validFrom?: string;
  validTo?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Sales territories built on configurable administrative locations.
 * Locations are data, not code: the platform imports the official
 * Cambodian provinces/districts/communes (with validity dates, so boundary
 * changes are versioned), and each tenant may add its own groupings.
 */
@Injectable()
export class TerritoriesService {
  constructor(private readonly audit: AuditService) {}

  // ---- territories ---------------------------------------------------------

  async list(tx: Tx) {
    return tx.query(
      `SELECT t.id, t.code, t.name, t.territory_type, t.parent_id, t.team_id, tm.name AS team_name, t.is_active,
              COALESCE((SELECT json_agg(json_build_object('assignmentId', a.id, 'salesRepId', a.sales_rep_id, 'name', u.full_name,
                         'role', a.role, 'validFrom', a.valid_from) ORDER BY a.role, u.full_name)
                  FROM sales_territory_assignments a JOIN sales_representatives r ON r.id = a.sales_rep_id JOIN users u ON u.id = r.user_id
                 WHERE a.territory_id = t.id AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE)), '[]') AS representatives,
              COALESCE((SELECT json_agg(json_build_object('id', l.id, 'level', l.level, 'code', l.code, 'name', l.name) ORDER BY l.level, l.name)
                  FROM sales_territory_locations tl JOIN admin_locations l ON l.id = tl.location_id WHERE tl.territory_id = t.id), '[]') AS locations,
              (SELECT count(DISTINCT customer_id) FROM sales_customer_assignments ca
                WHERE ca.territory_id = t.id AND (ca.valid_to IS NULL OR ca.valid_to >= CURRENT_DATE)) AS customer_count
         FROM sales_territories t LEFT JOIN sales_teams tm ON tm.id = t.team_id
        ORDER BY t.territory_type, t.code`,
    );
  }

  async create(tx: Tx, i: TerritoryInput) {
    await this.checkParent(tx, null, i.parentId ?? null);
    const t = await tx.one(
      `INSERT INTO sales_territories (tenant_id, code, name, territory_type, parent_id, team_id)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5) RETURNING *`,
      [i.code, i.name, i.territoryType, i.parentId ?? null, i.teamId ?? null],
    );
    await this.audit.record(tx, { action: 'TERRITORY_CREATED', entityType: 'sales_territory', entityId: t.id, after: t });
    return t;
  }

  async update(tx: Tx, id: string, i: Partial<TerritoryInput>) {
    const before = await tx.maybeOne('SELECT * FROM sales_territories WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Territory');
    if (i.parentId !== undefined) await this.checkParent(tx, id, i.parentId);
    const after = await tx.one(
      `UPDATE sales_territories SET name = COALESCE($2, name), territory_type = COALESCE($3, territory_type),
              parent_id = CASE WHEN $4::boolean THEN $5::uuid ELSE parent_id END,
              team_id = CASE WHEN $6::boolean THEN $7::uuid ELSE team_id END, is_active = COALESCE($8, is_active)
        WHERE id = $1 RETURNING *`,
      [id, i.name ?? null, i.territoryType ?? null, i.parentId !== undefined, i.parentId ?? null, i.teamId !== undefined, i.teamId ?? null, i.isActive ?? null],
    );
    await this.audit.record(tx, { action: 'TERRITORY_UPDATED', entityType: 'sales_territory', entityId: id, before, after });
    return after;
  }

  async setLocations(tx: Tx, id: string, locationIds: string[]) {
    await this.mustExist(tx, id);
    const found = await tx.query<{ id: string }>('SELECT id FROM admin_locations WHERE id = ANY($1::uuid[])', [locationIds]);
    if (found.length !== new Set(locationIds).size) throw new DomainError('LOCATION_NOT_FOUND', 'One or more locations do not exist', 422);
    await tx.query('DELETE FROM sales_territory_locations WHERE territory_id = $1', [id]);
    await tx.query(
      `INSERT INTO sales_territory_locations (tenant_id, territory_id, location_id) SELECT current_tenant_id(), $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [id, locationIds],
    );
    await this.audit.record(tx, { action: 'TERRITORY_LOCATIONS_SET', entityType: 'sales_territory', entityId: id, after: { locationIds } });
    return (await this.list(tx)).find((t: { id: string }) => t.id === id);
  }

  async assignRep(tx: Tx, user: TenantUser, id: string, i: { salesRepId: string; role: 'PRIMARY' | 'BACKUP'; validFrom?: string }) {
    await this.mustExist(tx, id);
    if (i.role === 'PRIMARY') {
      // One current primary: end the previous one the day before; one that never took effect is removed.
      await tx.query(
        `DELETE FROM sales_territory_assignments
          WHERE territory_id = $1 AND role = 'PRIMARY' AND valid_to IS NULL AND valid_from >= COALESCE($2::date, CURRENT_DATE)`,
        [id, i.validFrom ?? null],
      );
      await tx.query(
        `UPDATE sales_territory_assignments SET valid_to = COALESCE($2::date, CURRENT_DATE) - 1
          WHERE territory_id = $1 AND role = 'PRIMARY' AND valid_to IS NULL`,
        [id, i.validFrom ?? null],
      );
    }
    const a = await tx.one(
      `INSERT INTO sales_territory_assignments (tenant_id, territory_id, sales_rep_id, role, valid_from, assigned_by)
       VALUES (current_tenant_id(), $1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5) RETURNING *`,
      [id, i.salesRepId, i.role, i.validFrom ?? null, user.userId],
    );
    await this.audit.record(tx, { action: 'TERRITORY_REP_ASSIGNED', entityType: 'sales_territory', entityId: id, after: a });
    return a;
  }

  async endAssignment(tx: Tx, assignmentId: string, validTo?: string) {
    const a = await tx.maybeOne(
      `UPDATE sales_territory_assignments SET valid_to = GREATEST(valid_from, COALESCE($2::date, CURRENT_DATE))
        WHERE id = $1 AND valid_to IS NULL RETURNING *`,
      [assignmentId, validTo ?? null],
    );
    if (!a) throw notFound('Open territory assignment');
    await this.audit.record(tx, { action: 'TERRITORY_REP_UNASSIGNED', entityType: 'sales_territory', entityId: a.territory_id, after: a });
    return a;
  }

  /**
   * Assigns every customer whose default delivery address lies in the
   * territory's locations (or below them) to the territory's primary rep.
   * Customers already primarily assigned elsewhere are left alone unless
   * `reassign` is set.
   */
  async assignCustomersByLocation(tx: Tx, user: TenantUser, id: string, reassign: boolean) {
    await this.mustExist(tx, id);
    const primary = await tx.maybeOne<{ sales_rep_id: string }>(
      `SELECT sales_rep_id FROM sales_territory_assignments WHERE territory_id = $1 AND role = 'PRIMARY'
          AND valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
      [id],
    );
    if (!primary) throw new DomainError('NO_PRIMARY_REP', 'Assign a primary representative to the territory first', 422);
    const customers = await tx.query<{ customer_id: string; current_rep: string | null; current_id: string | null; current_from: string | null }>(
      `WITH RECURSIVE loc AS (
         SELECT l.id FROM sales_territory_locations tl JOIN admin_locations l ON l.id = tl.location_id WHERE tl.territory_id = $1
         UNION SELECT c.id FROM admin_locations c JOIN loc ON c.parent_id = loc.id
       )
       SELECT DISTINCT ON (a.customer_id) a.customer_id, ca.sales_rep_id AS current_rep, ca.id AS current_id, ca.valid_from AS current_from
         FROM customer_addresses a
         JOIN customers cu ON cu.id = a.customer_id AND cu.status = 'ACTIVE'
         LEFT JOIN sales_customer_assignments ca ON ca.customer_id = a.customer_id AND ca.assignment_type = 'PRIMARY' AND ca.valid_to IS NULL
        WHERE a.address_type = 'DELIVERY' AND a.location_id IN (SELECT id FROM loc)
        ORDER BY a.customer_id, a.is_default DESC`,
      [id],
    );
    let assigned = 0;
    let skipped = 0;
    for (const c of customers) {
      if (c.current_rep === primary.sales_rep_id) {
        await tx.query('UPDATE sales_customer_assignments SET territory_id = $2 WHERE id = $1', [c.current_id, id]);
        continue;
      }
      if (c.current_rep && !reassign) { skipped += 1; continue; }
      if (c.current_id) {
        if (c.current_from && c.current_from >= tx.today()) {
          await tx.query('DELETE FROM sales_customer_assignments WHERE id = $1', [c.current_id]);
        } else {
          await tx.query('UPDATE sales_customer_assignments SET valid_to = CURRENT_DATE - 1 WHERE id = $1', [c.current_id]);
        }
      }
      await tx.query(
        `INSERT INTO sales_customer_assignments (tenant_id, customer_id, sales_rep_id, territory_id, assignment_type, assigned_by)
         VALUES (current_tenant_id(), $1, $2, $3, 'PRIMARY', $4)`,
        [c.customer_id, primary.sales_rep_id, id, user.userId],
      );
      assigned += 1;
    }
    await this.audit.record(tx, { action: 'TERRITORY_CUSTOMERS_ASSIGNED', entityType: 'sales_territory', entityId: id, after: { assigned, skipped } });
    return { matched: customers.length, assigned, skipped };
  }

  // ---- administrative locations ---------------------------------------------

  locations(tx: Tx, q: { level?: string; parentId?: string; search?: string; countryCode?: string }) {
    return tx.query(
      `SELECT id, tenant_id IS NULL AS is_platform, country_code, parent_id, level, code, name, name_local, valid_from, valid_to, source
         FROM admin_locations
        WHERE country_code = COALESCE($1, 'KH')
          AND ($2::text IS NULL OR level = $2)
          AND ($3::uuid IS NULL OR parent_id = $3)
          AND ($4::text IS NULL OR lower(name) LIKE '%' || lower($4) || '%' OR name_local LIKE '%' || $4 || '%' OR code = $4)
          AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
        ORDER BY level, name LIMIT 500`,
      [q.countryCode ?? null, q.level ?? null, q.parentId ?? null, q.search ?? null],
    );
  }

  /**
   * Upserts locations by (country, level, code). Parents are matched by code
   * within the same import or existing data. tenantId null = platform data.
   */
  async importLocations(tx: Tx, tenantId: string | null, countryCode: string, source: string, rows: LocationImportRow[]) {
    const order = ['COUNTRY', 'REGION', 'PROVINCE', 'DISTRICT', 'COMMUNE', 'VILLAGE'];
    const sorted = [...rows].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
    let inserted = 0;
    let updated = 0;
    for (const r of sorted) {
      let parentId: string | null = null;
      if (r.parentCode) {
        const p = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM admin_locations WHERE country_code = $1 AND code = $2 AND ($3::text IS NULL OR level = $3)
              AND (tenant_id IS NULL OR tenant_id IS NOT DISTINCT FROM $4::uuid)
            ORDER BY (tenant_id IS NULL) LIMIT 1`,
          [countryCode, r.parentCode, r.parentLevel ?? null, tenantId],
        );
        if (!p) throw new DomainError('LOCATION_PARENT_NOT_FOUND', `Parent ${r.parentCode} of ${r.code} not found`, 422);
        parentId = p.id;
      }
      const res = await tx.one<{ inserted: boolean }>(
        `INSERT INTO admin_locations (tenant_id, country_code, parent_id, level, code, name, name_local, valid_from, valid_to, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), country_code, level, code)
         DO UPDATE SET parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, name_local = EXCLUDED.name_local,
                       valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, source = EXCLUDED.source
         RETURNING (xmax = 0) AS inserted`,
        [tenantId, countryCode, parentId, r.level, r.code, r.name, r.nameLocal ?? null, r.validFrom ?? null, r.validTo ?? null, source],
      );
      if (res.inserted) inserted += 1;
      else updated += 1;
    }
    return { inserted, updated };
  }

  // ---------------------------------------------------------------------------

  private async mustExist(tx: Tx, id: string) {
    if (!(await tx.maybeOne('SELECT 1 FROM sales_territories WHERE id = $1', [id]))) throw notFound('Territory');
  }

  /** Prevents a territory from becoming its own ancestor. */
  private async checkParent(tx: Tx, id: string | null, parentId: string | null) {
    if (!parentId) return;
    if (parentId === id) throw new DomainError('TERRITORY_CYCLE', 'A territory cannot be its own parent', 422);
    const chain = await tx.query<{ id: string }>(
      `WITH RECURSIVE up AS (SELECT id, parent_id FROM sales_territories WHERE id = $1
                             UNION SELECT t.id, t.parent_id FROM sales_territories t JOIN up ON t.id = up.parent_id)
       SELECT id FROM up`,
      [parentId],
    );
    if (!chain.length) throw notFound('Parent territory');
    if (id && chain.some((c) => c.id === id)) throw new DomainError('TERRITORY_CYCLE', 'That would make the territory its own ancestor', 422);
  }
}
