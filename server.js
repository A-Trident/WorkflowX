const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'workspace.enc');

const ENCRYPTION_KEY = crypto.scryptSync('FlowForgeEnterpriseSecret', 'salt', 32); 
const IV_LENGTH = 16;

function encrypt(text) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    try {
        let textParts = text.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        return '{"projects":[]}';
    }
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let memoryState = { projects: [] };
if (fs.existsSync(FILE_PATH)) {
    const encryptedData = fs.readFileSync(FILE_PATH, 'utf8');
    memoryState = JSON.parse(decrypt(encryptedData));
}

app.get('/api/workspace', (req, res) => res.json(memoryState));

io.on('connection', (socket) => {
    socket.on('sync-update', (data) => {
        memoryState = data;
        socket.broadcast.emit('workspace-updated', memoryState);
        fs.writeFileSync(FILE_PATH, encrypt(JSON.stringify(memoryState)));
    });
});



const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Enterprise Server running on port ${PORT}`));
