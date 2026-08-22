export function listCategories(db) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.parent_id AS parentId, p.name AS parentName,
              c.kind, c.exclude_from_spend AS excludeFromSpend, c.system, c.sort_order AS sortOrder
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
       ORDER BY COALESCE(p.sort_order, c.sort_order), c.parent_id IS NOT NULL, c.sort_order, c.name`,
    )
    .all();
}

export function createCategory(db, body) {
  const name = String(body?.name ?? '').trim();
  if (!name || name.length > 60) throw err(400, 'INVALID_NAME', 'Category name required (max 60 chars)');
  const kind = body?.kind;
  if (!['expense', 'income'].includes(kind)) {
    throw err(400, 'INVALID_KIND', "kind must be 'expense' or 'income' (groups are fixed)");
  }
  let parentId = null;
  if (body?.parentId != null) {
    const parent = db.prepare("SELECT id FROM categories WHERE id=? AND kind='group'").get(Number(body.parentId));
    if (!parent) throw err(400, 'INVALID_PARENT', 'parentId must reference a group category');
    parentId = parent.id;
  }
  const dup = db.prepare('SELECT id FROM categories WHERE name=? AND (parent_id IS ? OR parent_id=?)')
    .get(name, parentId, parentId ?? -1);
  if (dup) throw err(409, 'DUPLICATE_NAME', `Category ${JSON.stringify(name)} already exists there`);
  const r = db
    .prepare('INSERT INTO categories (name, parent_id, kind, exclude_from_spend, system) VALUES (?, ?, ?, ?, 0)')
    .run(name, parentId, kind, body?.excludeFromSpend ? 1 : 0);
  return db.prepare('SELECT * FROM categories WHERE id=?').get(r.lastInsertRowid);
}

export function updateCategory(db, id, body) {
  const existing = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  if (!existing) throw err(404, 'NOT_FOUND', 'No such category');
  if (existing.kind === 'group') throw err(400, 'GROUP_IMMUTABLE', 'Groups are fixed; rename leaves instead');
  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  if (!name || name.length > 60) throw err(400, 'INVALID_NAME', 'Name required (max 60)');
  const exclude = body.excludeFromSpend !== undefined ? (body.excludeFromSpend ? 1 : 0) : existing.exclude_from_spend;
  db.prepare('UPDATE categories SET name=?, exclude_from_spend=? WHERE id=?').run(name, exclude, id);
  return db.prepare('SELECT * FROM categories WHERE id=?').get(id);
}

function err(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
