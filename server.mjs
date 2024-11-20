import express from 'express';
import { createServer } from 'http';
import morgan from 'morgan';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const port = process.env.PORT || 3000;

// Initialize SQLite
const db = new sqlite3.Database('hive.db');
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

// Initialize database tables
async function initializeDatabase() {
  try {
    // Connections table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        cell_id TEXT NOT NULL,
        slide_element_id TEXT NOT NULL,
        active BOOLEAN DEFAULT 1,
        sync_enabled BOOLEAN DEFAULT 1,
        last_sync_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(cell_id, slide_element_id)
      )
    `);

    // Updates table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS updates (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        content TEXT NOT NULL,
        processed BOOLEAN DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    process.exit(1);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.post('/api/test/cleanup', async (req, res) => {
  try {
    await dbRun('DELETE FROM connections');
    await dbRun('DELETE FROM updates');
    res.json({ success: true });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { type } = req.body;
  
  if (!['sheets', 'slides'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid application type'
    });
  }

  try {
    const initialState = await getInitialData();
    res.json({ success: true, type, initialState });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/selection/:type/broadcast', async (req, res) => {
  const { type } = req.params;
  const { selection, element } = req.body;
  
  const content = type === 'sheets' ? selection : element;

  if (!content) {
    return res.status(400).json({
      success: false,
      error: `Missing ${type === 'sheets' ? 'selection' : 'element'} data`
    });
  }

  try {
    const id = `upd-${Date.now()}`;
    await dbRun(
      `INSERT INTO updates (id, type, source_type, target_type, content)
       VALUES (?, 'selection', ?, ?, ?)`,
      [id, type, type === 'sheets' ? 'slides' : 'sheets', JSON.stringify(content)]
    );

    const update = await dbGet('SELECT * FROM updates WHERE id = ?', [id]);
    res.json({ success: true, update });
  } catch (error) {
    console.error('Selection broadcast error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/updates/:type', async (req, res) => {
  const { type } = req.params;
  const { lastUpdate } = req.query;
  
  try {
    const updates = await dbAll(
      `SELECT * FROM updates 
       WHERE target_type = ? 
       AND processed = 0 
       AND timestamp > datetime(?, 'unixepoch', 'millisecond')
       ORDER BY timestamp ASC`,
      [type, lastUpdate]
    );
    res.json({ success: true, updates });
  } catch (error) {
    console.error('Updates fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/connections', async (req, res) => {
  const { cellId, slideElementId } = req.body;

  if (!cellId || !slideElementId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }

  try {
    // Check if connection already exists
    const existingConnection = await dbGet(
      'SELECT * FROM connections WHERE cell_id = ? AND slide_element_id = ?',
      [cellId, slideElementId]
    );

    if (existingConnection) {
      // If exists but inactive, reactivate it
      if (!existingConnection.active) {
        await dbRun(
          `UPDATE connections 
           SET active = 1, sync_enabled = 1, last_sync_time = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [existingConnection.id]
        );
        const updatedConnection = await dbGet(
          'SELECT * FROM connections WHERE id = ?',
          [existingConnection.id]
        );
        return res.json({ success: true, connection: updatedConnection });
      }
      // If already active, return existing connection
      return res.json({ success: true, connection: existingConnection });
    }

    // Create new connection if doesn't exist
    const id = `conn-${Date.now()}`;
    await dbRun(
      `INSERT INTO connections (id, cell_id, slide_element_id)
       VALUES (?, ?, ?)`,
      [id, cellId, slideElementId]
    );

    const connection = await dbGet('SELECT * FROM connections WHERE id = ?', [id]);
    res.json({ success: true, connection });
  } catch (error) {
    console.error('Connection creation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/connections/:id', async (req, res) => {
  const { id } = req.params;
  const { active, syncEnabled } = req.body;

  try {
    await dbRun(
      `UPDATE connections 
       SET active = ?, sync_enabled = ?, last_sync_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [active, syncEnabled, id]
    );

    const connection = await dbGet('SELECT * FROM connections WHERE id = ?', [id]);
    res.json({ success: true, connection });
  } catch (error) {
    console.error('Connection update error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/updates/acknowledge', async (req, res) => {
  const { updateIds } = req.body;

  if (!updateIds || !Array.isArray(updateIds)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid update IDs'
    });
  }

  try {
    const placeholders = updateIds.map(() => '?').join(',');
    await dbRun(
      `UPDATE updates SET processed = 1 WHERE id IN (${placeholders})`,
      updateIds
    );

    res.json({ success: true, processed: updateIds.length });
  } catch (error) {
    console.error('Update acknowledgment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/connections/health', async (req, res) => {
  try {
    const staleConnections = await dbAll(
      `SELECT * FROM connections 
       WHERE active = 1 
       AND last_sync_time < datetime('now', '-5 minutes')`
    );

    res.json({ 
      success: true, 
      staleConnections,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Connection health check error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/updates/cell', async (req, res) => {
  const { connectionId, value, timestamp } = req.body;

  if (!connectionId || value === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }

  try {
    const connection = await dbGet(
      'SELECT * FROM connections WHERE id = ?',
      [connectionId]
    );

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Connection not found'
      });
    }

    const id = `upd-${Date.now()}`;
    await dbRun(
      `INSERT INTO updates (id, type, source_type, target_type, content)
       VALUES (?, 'value', 'sheets', 'slides', ?)`,
      [id, JSON.stringify({
        connectionId,
        value,
        slideElementId: connection.slide_element_id
      })]
    );

    // Update connection last sync time
    await dbRun(
      `UPDATE connections 
       SET last_sync_time = datetime(?, 'unixepoch', 'millisecond')
       WHERE id = ?`,
      [timestamp, connectionId]
    );

    const update = await dbGet('SELECT * FROM updates WHERE id = ?', [id]);
    res.json({ success: true, update });
  } catch (error) {
    console.error('Cell update error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper functions
async function getInitialData() {
  try {
    const [activeConnections, pendingUpdates] = await Promise.all([
      dbAll('SELECT * FROM connections WHERE active = 1'),
      dbAll('SELECT * FROM updates WHERE processed = 0 ORDER BY timestamp ASC')
    ]);

    return {
      connections: activeConnections,
      updates: pendingUpdates
    };
  } catch (error) {
    console.error('Error getting initial data:', error);
    throw error;
  }
}

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
async function startServer() {
  try {
    await initializeDatabase();
    httpServer.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export default app;
