import express from 'express';
import cors from 'cors';

const app = express();
const TEST_PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Store broadcasts for verification
const broadcasts = {
    sheets: [],
    slides: []
};

// Mock registration endpoint
app.post('/api/register', (req, res) => {
    const { type } = req.body;
    console.log(`\n[${type}] Registered`);
    res.json({
        success: true,
        type,
        initialState: {
            connections: []
        }
    });
});

// Mock selection broadcast endpoint
app.post('/api/selection/:type/broadcast', (req, res) => {
    const { type } = req.params;
    const content = req.body;
    
    broadcasts[type].push({
        timestamp: Date.now(),
        content
    });

    console.log(`\n[${type.toUpperCase()}] Selection Broadcast:`, JSON.stringify(content, null, 2));
    
    res.json({
        success: true,
        update: {
            id: `test-${Date.now()}`,
            type: 'selection',
            content
        }
    });
});

// Mock updates endpoint
app.get('/api/updates/:type', (req, res) => {
    const { type } = req.params;
    const { lastUpdate } = req.query;
    
    // Get updates after lastUpdate
    const updates = broadcasts[type === 'sheets' ? 'slides' : 'sheets']
        .filter(b => b.timestamp > parseInt(lastUpdate))
        .map(b => ({
            id: `test-${b.timestamp}`,
            type: 'selection',
            source_type: type === 'sheets' ? 'slides' : 'sheets',
            target_type: type,
            content: b.content,
            processed: false,
            timestamp: new Date(b.timestamp).toISOString()
        }));

    res.json({
        success: true,
        updates
    });
});

// Start server
app.listen(TEST_PORT, () => {
    console.log(`Test server running on port ${TEST_PORT}`);
    console.log('Ready to receive selection broadcasts...\n');
});
