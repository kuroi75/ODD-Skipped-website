const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'data', '.env') }); 

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GOOGLE_SHEET_WEBHOOK = process.env.GOOGLE_SHEET_WEBHOOK || null;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    console.error('\n❌  ERROR: ADMIN_USERNAME and ADMIN_PASSWORD must be set in the data/.env file.');
    process.exit(1);
}

async function syncToGoogleSheets(type, data) {
    if (!GOOGLE_SHEET_WEBHOOK) return;
    try {
        await fetch(GOOGLE_SHEET_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: type, payload: data })
        });
    } catch (err) {}
}

const activeSessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static('public'));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const UPLOADS_DIR   = path.join(__dirname, 'uploads');
const DATA_DIR      = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE   = path.join(DATA_DIR, 'orders.json');

[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');
if (!fs.existsSync(ORDERS_FILE))   fs.writeFileSync(ORDERS_FILE,   '[]');

const readJSON  = (file) => { try { const d = fs.readFileSync(file, 'utf8'); return d ? JSON.parse(d) : []; } catch(e) { return []; } };
const writeJSON = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error('Write error:', e); } };

// ── AUTO-REPAIR SCRIPT ──
// This will instantly fix any broken "undefined" values and generate SKUs for old products!
let currentProducts = readJSON(PRODUCTS_FILE);
let needsSave = false;
currentProducts = currentProducts.map(p => {
    if (!p.sku) { p.sku = 'OS-' + Math.floor(100 + Math.random() * 900); needsSave = true; }
    if (p.stock === undefined) { p.stock = 10; needsSave = true; }
    
    // Fix the broken strings caused by the old bug
    if (!p.category || p.category === 'undefined') { p.category = 'Men'; needsSave = true; }
    if (!p.productType || p.productType === 'null' || p.productType === 'undefined') { p.productType = 'Bag'; needsSave = true; }
    if (!p.availability || p.availability === 'undefined') { p.availability = 'Available'; needsSave = true; }
    
    return p;
});
if (needsSave) writeJSON(PRODUCTS_FILE, currentProducts);


const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-'))
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed.'));
    }
});

function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ success: false, message: 'Not authenticated.' });
    const session = activeSessions.get(token);
    if (!session) return res.status(401).json({ success: false, message: 'Invalid session.' });
    if (Date.now() > session.expiresAt) {
        activeSessions.delete(token);
        return res.status(401).json({ success: false, message: 'Session expired.' });
    }
    req.adminUser = session.username;
    next();
}

function buildImageUrl(req, filename) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host     = req.headers['x-forwarded-host']  || req.get('host');
    return `${protocol}://${host}/uploads/${filename}`;
}

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    let uMatch = false, pMatch = false;
    try {
        uMatch = crypto.timingSafeEqual(Buffer.from(username.padEnd(64)), Buffer.from(ADMIN_USERNAME.padEnd(64)));
        pMatch = crypto.timingSafeEqual(Buffer.from(password.padEnd(64)), Buffer.from(ADMIN_PASSWORD.padEnd(64)));
    } catch(_) {}

    if (uMatch && pMatch) {
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
        res.json({ success: true, token, username });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
    activeSessions.delete((req.headers['authorization'] || '').replace('Bearer ', '').trim());
    res.json({ success: true });
});

// ══════════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════════
app.get('/api/products', (req, res) => res.json(readJSON(PRODUCTS_FILE)));

app.post('/api/products', requireAuth, upload.any(), (req, res) => {
    try {
        const products = readJSON(PRODUCTS_FILE);
        const body = req.body;
        
        let imageUrls = [];
        if (body.existingImages) {
            try { imageUrls = JSON.parse(body.existingImages); } 
            catch(e) { imageUrls = Array.isArray(body.existingImages) ? body.existingImages : [body.existingImages]; }
        } else if (body.existingImage) imageUrls.push(body.existingImage);

        if (req.files && req.files.length > 0) {
            req.files.forEach(f => imageUrls.push(buildImageUrl(req, f.filename)));
        }

        const product = {
            id:            body.id || Date.now().toString(),
            sku:           body.sku || ('OS-' + Math.floor(100 + Math.random() * 900)),
            stock:         parseInt(body.stock) || 0,
            name:          body.name,
            price:         parseFloat(body.price),
            originalPrice: body.originalPrice ? parseFloat(body.originalPrice) : null,
            category:      body.category,
            productType:   body.productType || null,
            availability:  body.availability,
            preOrder:      body.preOrder === 'true',
            description:   body.description || '',
            imageUrls:     imageUrls,
            imageUrl:      imageUrls.length > 0 ? imageUrls[0] : '', 
            hasGiftBox:    body.hasGiftBox === 'true',
            hasFreeDel:    body.hasFreeDel === 'true',
            isHotSell:     body.isHotSell === 'true'
        };

        const idx = products.findIndex(p => p.id === product.id);
        if (idx !== -1) products[idx] = product; else products.push(product);
        writeJSON(PRODUCTS_FILE, products);
        
        syncToGoogleSheets('product', product);
        res.json({ success: true, product });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
    try {
        let products = readJSON(PRODUCTS_FILE);
        const toDelete = products.find(p => p.id === req.params.id);
        if (toDelete?.imageUrls) {
            toDelete.imageUrls.forEach(url => {
                const fn = url.split('/uploads/')[1];
                if (fn) { const fp = path.join(UPLOADS_DIR, fn); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
            });
        }
        writeJSON(PRODUCTS_FILE, products.filter(p => p.id !== req.params.id));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ══════════════════════════════════════════════
// ORDERS
// ══════════════════════════════════════════════
app.get('/api/orders', requireAuth, (req, res) => res.json(readJSON(ORDERS_FILE)));

app.post('/api/orders', (req, res) => {
    try {
        const orders = readJSON(ORDERS_FILE);
        const advance = req.body.advance || 0;
        const order = { 
            ...req.body, 
            id: req.body.id || ('OS-' + Date.now()), 
            date: req.body.date || new Date().toISOString(), 
            status: 'new',
            paidAmount: advance,
            paymentStatus: advance > 0 ? 'Partial' : 'Pending'
        };
        orders.unshift(order);
        writeJSON(ORDERS_FILE, orders);
        
        syncToGoogleSheets('order', order);
        res.json({ success: true, order });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/orders/:id', requireAuth, (req, res) => {
    try {
        const orders = readJSON(ORDERS_FILE);
        const idx = orders.findIndex(o => o.id === req.params.id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Order not found.' });
        
        orders[idx] = { ...orders[idx], ...req.body };
        
        if (req.body.paidAmount !== undefined) {
             const paid = parseFloat(req.body.paidAmount);
             const total = parseFloat(orders[idx].total);
             if (paid >= total) orders[idx].paymentStatus = 'Paid';
             else if (paid > 0) orders[idx].paymentStatus = 'Partial';
             else orders[idx].paymentStatus = 'Pending';
        }

        writeJSON(ORDERS_FILE, orders);
        syncToGoogleSheets('order', orders[idx]);
        res.json({ success: true, order: orders[idx] });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/orders/:id', requireAuth, (req, res) => {
    try {
        const orders = readJSON(ORDERS_FILE);
        writeJSON(ORDERS_FILE, orders.filter(o => o.id !== req.params.id));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(PORT, () => console.log(`\n🚀 ODD SKIPPED Server running at http://localhost:${PORT}`));