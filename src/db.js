const sql = require('mssql');
const config = require('./config');

let pool = null;

async function connectDb() {
  pool = await sql.connect(config.db);
  return pool;
}

function getPool() {
  if (!pool) throw new Error('Database pool is not connected');
  return pool;
}

function bindInputs(request, params) {
  if (!params) return request;
  for (const [name, value] of Object.entries(params)) {
    request.input(name, value);
  }
  return request;
}

async function query(text, params) {
  const request = getPool().request();
  bindInputs(request, params);
  const result = await request.query(text);
  // MERGE/INSERT/UPDATE khong OUTPUT khong co recordset -> tra [] de queryOne khong vo undefined
  return result.recordset || [];
}

async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

async function withTransaction(fn) {
  const tx = new sql.Transaction(getPool());
  await tx.begin();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // ignore rollback failure, throw original error
    }
    throw err;
  }
}

function txQuery(tx, text, params) {
  const request = new sql.Request(tx);
  bindInputs(request, params);
  return request.query(text).then((result) => result.recordset || []);
}

// Tao menh de IN (@p0, @p1, ...) tu mang gia tri
function inClause(values, prefix) {
  const names = values.map((_, i) => `@${prefix}${i}`);
  const params = {};
  values.forEach((value, i) => {
    params[`${prefix}${i}`] = value;
  });
  return { sql: names.join(', '), params };
}

const NUMERIC_ID_RE = /^[A-Za-z0-9_-]+$/;

function inClauseSafe(values, prefix) {
  if (values.length <= 500) return inClause(values, prefix);
  const allSafe = values.every((v) => NUMERIC_ID_RE.test(String(v)));
  if (!allSafe) return inClause(values, prefix);
  const literals = values.map((v) => `'${String(v).replace(/'/g, '\'\'')}'`).join(', ');
  return { sql: literals, params: {} };
}

module.exports = { connectDb, getPool, query, queryOne, withTransaction, txQuery, inClause, inClauseSafe, sql };
