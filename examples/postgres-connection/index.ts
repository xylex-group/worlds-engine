import { World, workflow, activity } from 'worlds-engine'
import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/dbname'

const pool = new Pool({
  connectionString,
  max: 5
})

const queryPostgres = activity('query-postgres', async (ctx, { sql, params = [] }) => {
  ctx.heartbeat('executing query')
  
  if (!process.env.DATABASE_URL || connectionString.includes('localhost')) {
    console.log(`[DEMO] would execute: ${sql}`)
    await sleep(300)
    return { rows: [], rowCount: 0 }
  }
  
  const client = await pool.connect()
  
  try {
    const result = await client.query(sql, params)
    console.log(`query executed: ${result.rowCount} rows`)
    return { rows: result.rows, rowCount: result.rowCount }
  } finally {
    client.release()
  }
}, {
  retry: { maxAttempts: 3, backoff: 'exponential' },
  timeout: '30s'
})

const createTable = activity('create-table', async (ctx, { tableName, schema }) => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      ${schema}
    )
  `
  
  return await ctx.run(queryPostgres, { sql })
})

const insertRecord = activity('insert-record', async (ctx, { table, data }) => {
  const columns = Object.keys(data).join(', ')
  const values = Object.values(data)
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  
  const sql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`
  
  return await ctx.run(queryPostgres, { sql, params: values })
})

const selectRecords = activity('select-records', async (ctx, { table, where = {}, limit = 100 }) => {
  let sql = `SELECT * FROM ${table}`
  const params: any[] = []
  
  if (Object.keys(where).length > 0) {
    const conditions = Object.entries(where).map(([key, value], index) => {
      params.push(value)
      return `${key} = $${params.length}`
    })
    sql += ` WHERE ${conditions.join(' AND ')}`
  }
  
  sql += ` LIMIT $${params.length + 1}`
  params.push(limit)
  
  return await ctx.run(queryPostgres, { sql, params })
})

const updateRecord = activity('update-record', async (ctx, { table, id, updates }) => {
  const setClause = Object.keys(updates).map((key, index) => `${key} = $${index + 1}`).join(', ')
  const values = Object.values(updates)
  values.push(id)
  
  const sql = `UPDATE ${table} SET ${setClause} WHERE id = $${values.length} RETURNING *`
  
  return await ctx.run(queryPostgres, { sql, params: values })
})

const postgresWorkflow = workflow('postgres-workflow', async (ctx, { action, tableName, data }) => {
  console.log(`starting postgres workflow: ${action}`)
  
  if (action === 'setup') {
    await ctx.run(createTable, {
      tableName,
      schema: `
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      `
    })
    
    const inserted = await ctx.run(insertRecord, {
      table: tableName,
      data: {
        name: data.name,
        email: data.email
      }
    })
    
    return { action: 'setup', table: tableName, record: inserted.rows[0] }
  }
  
  if (action === 'query') {
    const results = await ctx.run(selectRecords, {
      table: tableName,
      where: data.where || {},
      limit: data.limit || 10
    })
    
    return { action: 'query', table: tableName, records: results.rows, count: results.rowCount }
  }
  
  if (action === 'update') {
    const updated = await ctx.run(updateRecord, {
      table: tableName,
      id: data.id,
      updates: data.updates
    })
    
    return { action: 'update', table: tableName, record: updated.rows[0] }
  }
  
  throw new Error(`unknown action: ${action}`)
})

const world = new World({
  minWorkers: 2,
  maxWorkers: 5,
  persistence: 'memory'
})

world.register(
  postgresWorkflow,
  queryPostgres,
  createTable,
  insertRecord,
  selectRecords,
  updateRecord
)

await world.start()

console.log('postgres connection workflow example')
console.log('set DATABASE_URL environment variable to use real postgres\n')

const handle = await world.execute('postgres-workflow', {
  action: 'setup',
  tableName: 'users',
  data: {
    name: 'test user',
    email: 'test@example.com'
  }
})

console.log(`workflow started: ${handle.workflowId}`)

const result = await handle.result()
console.log('\nworkflow completed:', result)

await pool.end()
await world.shutdown()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

