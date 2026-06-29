const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

// Load environment variables from .env file if it exists
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (e) {
  // Ignore error if file doesn't exist
}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'database.db');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', generalLimiter);

// Database setup
let db = new sqlite3.Database(DB_PATH);

// Helper functions for Database Promises
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// IST Date formatter helper: returns "YYYY-MM-DD HH:mm:ss"
function getISTTimestamp(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  const second = parts.find(p => p.type === 'second').value;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

// Generate unique alphanumeric IDs (12 chars from 62-char set = ~3 quintillion combinations)
function generateID(prefix, length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}-${result}`;
}

// ================= BACKUP & RESTORE CORE LOGIC =================

// Creates a zip backup including a consistent copy of the SQLite db, the .env file, and backup metadata
async function createBackup(user, type) {
  const backupsDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const backupId = generateID('BCK');
  const now = getISTTimestamp();
  const fileDate = now.replace(/[: ]/g, '_');
  const zipFilename = `backup_${fileDate}.zip`;
  const zipPath = path.join(backupsDir, zipFilename);
  const tempDbPath = path.join(__dirname, `temp_db_${backupId}.db`);

  let status = 'failed';
  let size = 0;
  let errMsg = null;

  try {
    // 1. Consistent online copy of db using VACUUM INTO
    await dbRun(`VACUUM INTO ?`, [tempDbPath]);

    // 2. Compress files
    const zip = new AdmZip();
    zip.addLocalFile(tempDbPath, undefined, 'database.db');
    if (fs.existsSync(path.join(__dirname, '.env'))) {
      zip.addLocalFile(path.join(__dirname, '.env'), undefined, '.env');
    }
    const metadata = {
      backup_id: backupId,
      backup_time: now,
      version: '1.0.0',
      user_email: user.email
    };
    zip.addFile('backup_metadata.json', Buffer.from(JSON.stringify(metadata, null, 2)));
    zip.writeZip(zipPath);

    // Get size
    const stats = fs.statSync(zipPath);
    size = stats.size;

    // 3. Clean up temp db
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }

    // 4. Send Email (non-blocking - backup is already created)
    try {
      await sendBackupEmail(user.email, zipPath, zipFilename);
    } catch (emailErr) {
      console.error('Backup email failed (backup file saved):', emailErr.message);
    }
    status = 'success';
  } catch (err) {
    console.error('Backup creation error:', err);
    status = 'failed';
    errMsg = err.message || 'Unknown error occurred during backup creation';
    // Clean up temp db on error
    if (fs.existsSync(tempDbPath)) {
      try { fs.unlinkSync(tempDbPath); } catch (e) { console.error('Failed to cleanup temp DB:', e); }
    }
  }

  // 5. Save in history
  await dbRun(
    `INSERT INTO backup_history (id, user_id, timestamp, type, status, size, filepath, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [backupId, user.id, now, type, status, size, zipFilename, errMsg]
  );

  // 6. Update user's last_backup_timestamp
  if (status === 'success') {
    await dbRun(`UPDATE user_profile SET last_backup_timestamp = ? WHERE id = ?`, [now, user.id]);
  }

  return { backupId, status, error: errMsg };
}

// Sends a backup zip file via email using nodemailer (configured via environment variables)
async function sendBackupEmail(email, zipPath, filename) {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT) || 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error('SMTP configuration missing: SMTP_USER and SMTP_PASS must be defined in your environment variables');
  }

  const transporter = nodemailer.createTransport({
    host: host,
    port: port,
    secure: port === 465,
    auth: {
      user: user,
      pass: pass
    }
  });

  const mailOptions = {
    from: `"KhataBook Backup Manager" <${user}>`,
    to: email,
    subject: `KhataBook Backup - ${new Date().toLocaleDateString()}`,
    text: `Hello,\n\nPlease find attached the automated backup of your KhataBook data generated on ${getISTTimestamp()}.\n\nThis file contains all your ledgers, bank accounts, Aadhaar cards, and profile settings.\n\nRegards,\nKhataBook Manager`,
    attachments: [
      {
        filename: filename,
        path: zipPath
      }
    ]
  };

  await transporter.sendMail(mailOptions);
}

// Restores data from a backup ZIP file
async function restoreBackup(zipFilename, userId) {
  const zipPath = path.join(__dirname, 'backups', zipFilename);
  if (!fs.existsSync(zipPath)) {
    throw new Error('Backup file does not exist locally');
  }

  const zip = new AdmZip(zipPath);
  const metadataEntry = zip.getEntry('backup_metadata.json');
  const dbEntry = zip.getEntry('database.db');

  if (!metadataEntry || !dbEntry) {
    throw new Error('Invalid backup file: missing database.db or backup_metadata.json');
  }

  // Extract temp restore db
  const tempRestoreDb = path.join(__dirname, 'temp_restore.db');
  zip.extractEntryTo(dbEntry, __dirname, false, true, false, 'temp_restore.db');

  // Verify that the restored file is a valid sqlite database
  let testDb;
  try {
    await new Promise((resolve, reject) => {
      testDb = new sqlite3.Database(tempRestoreDb, sqlite3.OPEN_READONLY, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // Check reading table
    await new Promise((resolve, reject) => {
      testDb.get(`SELECT COUNT(*) as count FROM user_profile`, (err, row) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    if (fs.existsSync(tempRestoreDb)) fs.unlinkSync(tempRestoreDb);
    throw new Error('Restored file validation failed: the backup database file is corrupt or invalid');
  } finally {
    if (testDb) {
      await new Promise(resolve => testDb.close(() => resolve()));
    }
  }

  // 1. Close current database
  await new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Small delay to ensure file handle is released on Windows
  await new Promise(resolve => setTimeout(resolve, 100));

  // 2. Overwrite database.db
  try {
    fs.renameSync(tempRestoreDb, DB_PATH);
  } catch (err) {
    fs.copyFileSync(tempRestoreDb, DB_PATH);
    fs.unlinkSync(tempRestoreDb);
  }

  // Extract .env if present in backup zip
  const envEntry = zip.getEntry('.env');
  if (envEntry) {
    zip.extractEntryTo(envEntry, __dirname, false, true);
  }

  // 3. Re-open database
  db = new sqlite3.Database(DB_PATH);
  
  // Re-enable foreign keys
  await new Promise((resolve, reject) => {
    db.run('PRAGMA foreign_keys = ON', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // 4. Run migrations to add user_id columns if missing (for backward compatibility with old backups)
  await runPostRestoreMigrations(userId);
}

async function runPostRestoreMigrations(userId) {
  // Add user_id to customers
  try {
    await dbRun(`ALTER TABLE customers ADD COLUMN user_id TEXT`);
    console.log('[Post-Restore Migration] Added user_id column to customers');
  } catch (e) {
    // Column may already exist
  }
  // Migrate existing customers to current user
  await dbRun(`UPDATE customers SET user_id = ? WHERE user_id IS NULL`, [userId]);

  // Add user_id to transactions
  try {
    await dbRun(`ALTER TABLE transactions ADD COLUMN user_id TEXT`);
    console.log('[Post-Restore Migration] Added user_id column to transactions');
  } catch (e) {}
  await dbRun(`UPDATE transactions SET user_id = ? WHERE user_id IS NULL`, [userId]);

  // Add user_id to aadhaar_cards
  try {
    await dbRun(`ALTER TABLE aadhaar_cards ADD COLUMN user_id TEXT`);
    console.log('[Post-Restore Migration] Added user_id column to aadhaar_cards');
  } catch (e) {}
  await dbRun(`UPDATE aadhaar_cards SET user_id = ? WHERE user_id IS NULL`, [userId]);

  // Add user_id to bank_accounts
  try {
    await dbRun(`ALTER TABLE bank_accounts ADD COLUMN user_id TEXT`);
    console.log('[Post-Restore Migration] Added user_id column to bank_accounts');
  } catch (e) {}
  await dbRun(`UPDATE bank_accounts SET user_id = ? WHERE user_id IS NULL`, [userId]);

  // Add user_id to activity_logs
  try {
    await dbRun(`ALTER TABLE activity_logs ADD COLUMN user_id TEXT`);
    console.log('[Post-Restore Migration] Added user_id column to activity_logs');
  } catch (e) {}
  await dbRun(`UPDATE activity_logs SET user_id = ? WHERE user_id IS NULL`, [userId]);
}

// Background backup scheduler running every minute
function initBackupScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      // Format as HH:MM in IST
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      const parts = formatter.formatToParts(now);
      const hour = parts.find(p => p.type === 'hour').value;
      const minute = parts.find(p => p.type === 'minute').value;
      const currentTime = `${hour}:${minute}`;

      // Also match previous minute to avoid missing due to timer drift
      const prevMinute = minute === '00' ? '59' : String(parseInt(minute, 10) - 1).padStart(2, '0');
      const prevHour = minute === '00' ? String(parseInt(hour, 10) - 1).padStart(2, '0') : hour;

      const users = await dbAll(
        `SELECT * FROM user_profile WHERE backup_schedule != 'manual' AND (backup_time = ? OR backup_time = ?)`,
        [currentTime, `${prevHour}:${prevMinute}`]
      );

      for (const user of users) {
        let shouldBackup = false;
        
        if (!user.last_backup_timestamp) {
          shouldBackup = true;
        } else {
          // Parse last backup date in IST using proper timezone
          const lastBackupDate = new Date(user.last_backup_timestamp.replace(' ', 'T') + '+05:30');
          const timeDiff = now.getTime() - lastBackupDate.getTime();
          const daysDiff = timeDiff / (1000 * 3600 * 24);

          if (user.backup_schedule === 'daily' && daysDiff >= 0.95) {
            shouldBackup = true;
          } else if (user.backup_schedule === 'weekly' && daysDiff >= 6.95) {
            shouldBackup = true;
          } else if (user.backup_schedule === '10days' && daysDiff >= 9.95) {
            shouldBackup = true;
          } else if (user.backup_schedule === 'monthly' && daysDiff >= 27.95) {
            shouldBackup = true;
          }
        }

        if (shouldBackup) {
          console.log(`[Scheduler] Triggering automatic backup for user ${user.name} (${user.email})`);
          await createBackup(user, 'automatic');
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error in backup scheduling check:', err);
    }
  }, 60000); // check every 60 seconds
}

// ================= CRYPTO & AUTH HELPERS =================

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const hashBuffer = Buffer.from(hash, 'hex');
    const derivedBuffer = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(hashBuffer, derivedBuffer);
  } catch {
    return false;
  }
}

function isPasswordHashed(pw) {
  return typeof pw === 'string' && pw.includes(':') && pw.split(':')[0].length === 32;
}

function generateSessionToken() {
  return crypto.randomBytes(48).toString('hex');
}

// Auth Middleware — validates Authorization: Bearer <token>
async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  const token = authHeader.slice(7);
  try {
    const session = await dbGet(`SELECT * FROM sessions WHERE id = ?`, [token]);
    if (!session) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const now = getISTTimestamp();
    if (session.expires_at < now) {
      await dbRun(`DELETE FROM sessions WHERE id = ?`, [token]);
      return res.status(401).json({ error: 'Session expired' });
    }
    const profile = await dbGet(`SELECT * FROM user_profile WHERE id = ?`, [session.user_id]);
    if (!profile) {
      return res.status(401).json({ error: 'User not found' });
    }
    delete profile.password;
    req.user = profile;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

// Enable Foreign Keys
db.run('PRAGMA foreign_keys = ON');


// ================= AUTH ENDPOINTS =================

// POST /api/login
app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const user = await dbGet(
      `SELECT * FROM user_profile WHERE email = ? OR username = ?`,
      [email.trim(), email.trim()]
    );
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const valid = isPasswordHashed(user.password)
      ? verifyPassword(password, user.password)
      : user.password === password; // fallback for legacy plain-text
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Migrate plain-text password on successful login
    if (!isPasswordHashed(user.password)) {
      await dbRun(`UPDATE user_profile SET password = ? WHERE id = ?`, [hashPassword(password), user.id]);
    }
    const token = generateSessionToken();
    const now = getISTTimestamp();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + (rememberMe ? 30 : 1));
    const expiresAt = getISTTimestamp(expiryDate);
    await dbRun(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [token, user.id, expiresAt]);
    await dbRun(`UPDATE user_profile SET last_login = ? WHERE id = ?`, [now, user.id]);
    await logActivity('login', `User ${user.name} logged in successfully`, user.id);
    const profile = { ...user };
    delete profile.password;
    res.json({ token, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/register
app.post('/api/register', authLimiter, async (req, res) => {
  const { name, username, email, mobile, password, role } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'Username is required' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const existingEmail = await dbGet(`SELECT id FROM user_profile WHERE email = ?`, [email.trim()]);
    if (existingEmail) return res.status(400).json({ error: 'Email already registered' });
    const existingUsername = await dbGet(`SELECT id FROM user_profile WHERE username = ?`, [username.trim()]);
    if (existingUsername) return res.status(400).json({ error: 'Username already taken' });
    const newId = generateID('USR');
    const now = getISTTimestamp();
    const hashedPw = hashPassword(password);
    await dbRun(
      `INSERT INTO user_profile (id, name, username, role, email, mobile, password, timezone, theme, language, created_at, updated_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, name.trim(), username.trim().toLowerCase(), role || 'Owner', email.trim(), mobile ? mobile.trim() : '', hashedPw, 'Asia/Kolkata', 'system', 'en', now, now, now]
    );
    await logActivity('register', `New user registered: ${name.trim()}`, newId);
    const token = generateSessionToken();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 1);
    const expiresAt = getISTTimestamp(expiryDate);
    await dbRun(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [token, newId, expiresAt]);
    const profile = await dbGet(`SELECT * FROM user_profile WHERE id = ?`, [newId]);
    delete profile.password;
    res.status(201).json({ token, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logout (and alias /api/auth/logout)
async function handleLogout(req, res) {
  const authHeader = req.headers['authorization'];
  let uid = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const session = await dbGet(`SELECT user_id FROM sessions WHERE id = ?`, [token]);
      if (session) uid = session.user_id;
    } catch (e) {}
    await dbRun(`DELETE FROM sessions WHERE id = ?`, [token]).catch(err => console.error('Failed to delete session:', err));
  }
  await logActivity('logout', 'User logged out', uid).catch(err => console.error('Failed to log logout activity:', err));
  res.json({ success: true });
}
app.post('/api/logout', handleLogout);
app.post('/api/auth/logout', handleLogout);

// GET /api/session-check
app.get('/api/session-check', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No session' });
  }
  const token = authHeader.slice(7);
  try {
    const session = await dbGet(`SELECT * FROM sessions WHERE id = ?`, [token]);
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const now = getISTTimestamp();
    if (session.expires_at < now) {
      await dbRun(`DELETE FROM sessions WHERE id = ?`, [token]);
      return res.status(401).json({ error: 'Session expired' });
    }
    const profile = await dbGet(`SELECT * FROM user_profile WHERE id = ?`, [session.user_id]);
    if (!profile) return res.status(401).json({ error: 'User not found' });
    delete profile.password;
    res.json({ user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forgot-password/request
app.post('/api/forgot-password/request', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const user = await dbGet(`SELECT id, name FROM user_profile WHERE email = ?`, [email.trim()]);
    if (!user) return res.status(404).json({ error: 'No account found with this email' });
    // Generate a 6-digit mock code (in production, email it)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDate = new Date();
    expiryDate.setMinutes(expiryDate.getMinutes() + 15);
    const expiresAt = getISTTimestamp(expiryDate);
    // Store in sessions table temporarily with a reset prefix
    await dbRun(`DELETE FROM sessions WHERE id LIKE 'RESET_%' AND user_id = ?`, [user.id]);
    await dbRun(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [`RESET_${code}`, user.id, expiresAt]);
    // In real implementation, send email. For now, return code in response for demo purposes.
    res.json({ success: true, message: 'Reset code sent (demo: code is in response)', demo_code: code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forgot-password/verify
app.post('/api/forgot-password/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  try {
    const user = await dbGet(`SELECT id FROM user_profile WHERE email = ?`, [email.trim()]);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const session = await dbGet(`SELECT * FROM sessions WHERE id = ? AND user_id = ?`, [`RESET_${code}`, user.id]);
    if (!session) return res.status(400).json({ error: 'Invalid or expired reset code' });
    const now = getISTTimestamp();
    if (session.expires_at < now) {
      await dbRun(`DELETE FROM sessions WHERE id = ?`, [`RESET_${code}`]);
      return res.status(400).json({ error: 'Reset code has expired' });
    }
    res.json({ success: true, reset_token: `RESET_${code}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forgot-password/reset
app.post('/api/forgot-password/reset', async (req, res) => {
  const { email, reset_token, new_password } = req.body;
  if (!email || !reset_token || !new_password) return res.status(400).json({ error: 'All fields are required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const user = await dbGet(`SELECT id FROM user_profile WHERE email = ?`, [email.trim()]);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const session = await dbGet(`SELECT * FROM sessions WHERE id = ? AND user_id = ?`, [reset_token, user.id]);
    if (!session) return res.status(400).json({ error: 'Invalid reset token' });
    const hashed = hashPassword(new_password);
    const now = getISTTimestamp();
    await dbRun(`UPDATE user_profile SET password = ?, updated_at = ? WHERE id = ?`, [hashed, now, user.id]);
    await dbRun(`DELETE FROM sessions WHERE id = ?`, [reset_token]);
    await logActivity('profile_update', 'Password reset via forgot password flow', user.id);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null
  });
});

// POST /api/auth/google
app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential, clientId: bodyClientId } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Credential token is required' });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID || bodyClientId;
  let googleId, email, name, picture;

  try {
    if (clientId) {
      // Live Mode: verify the token using Google tokeninfo API
      const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
      const verifyRes = await fetch(verifyUrl);
      if (!verifyRes.ok) {
        return res.status(401).json({ error: 'Failed to verify Google token' });
      }
      const payload = await verifyRes.json();
      
      // Verify audience and issuer
      if (payload.aud !== clientId) {
        return res.status(401).json({ error: 'Token audience does not match Client ID' });
      }
      if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
        return res.status(401).json({ error: 'Token issuer is invalid' });
      }

      googleId = payload.sub;
      email = payload.email;
      name = payload.name;
      picture = payload.picture;
    } else {
      // Mock/Simulation Mode
      if (!credential.startsWith('mock_token:')) {
        return res.status(400).json({ error: 'Invalid mock token' });
      }
      const parts = credential.split(':');
      email = parts[1];
      name = parts[2] || email.split('@')[0];
      googleId = `mock_google_id_${email}`;
      picture = '';
    }

    if (!email) {
      return res.status(400).json({ error: 'Google login failed: no email returned' });
    }

    email = email.trim().toLowerCase();

    // Check if user exists by google_id or email
    let user = await dbGet(`SELECT * FROM user_profile WHERE google_id = ? OR email = ?`, [googleId, email]);
    const now = getISTTimestamp();

    if (user) {
      // Link Google Account to existing local user if link is missing
      if (!user.google_id) {
        await dbRun(`UPDATE user_profile SET google_id = ?, updated_at = ? WHERE id = ?`, [googleId, now, user.id]);
        user.google_id = googleId;
      }
      // Update profile picture if missing
      if (picture && !user.profile_picture) {
        await dbRun(`UPDATE user_profile SET profile_picture = ? WHERE id = ?`, [picture, user.id]);
        user.profile_picture = picture;
      }
    } else {
      // Create new user via Google Sign-in
      const newId = generateID('USR');
      const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
      let baseUsername = emailPrefix || 'googleuser';
      let username = baseUsername;
      let suffix = 1;
      while (true) {
        const existing = await dbGet(`SELECT id FROM user_profile WHERE username = ?`, [username]);
        if (!existing) break;
        username = `${baseUsername}${suffix}`;
        suffix++;
      }

      const randomPassword = crypto.randomBytes(32).toString('hex');
      const hashedPw = hashPassword(randomPassword);

      await dbRun(
        `INSERT INTO user_profile (
          id, name, username, role, email, mobile, password, timezone, theme, language,
          created_at, updated_at, google_id, profile_picture
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId, name, username, 'Owner', email, '', hashedPw, 'Asia/Kolkata', 'system', 'en',
          now, now, googleId, picture || null
        ]
      );

      await logActivity('register', `New user registered via Google: ${name} (${email})`, newId);
      user = await dbGet(`SELECT * FROM user_profile WHERE id = ?`, [newId]);
    }

    // Generate Session Token
    const sessionToken = generateSessionToken();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30); // 30 days
    const expiresAt = getISTTimestamp(expiryDate);

    await dbRun(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [sessionToken, user.id, expiresAt]);
    await dbRun(`UPDATE user_profile SET last_login = ? WHERE id = ?`, [now, user.id]);
    await logActivity('login', `User ${user.name} logged in via Google`, user.id);

    const profile = { ...user };
    delete profile.password;

    res.json({ token: sessionToken, user: profile });

  } catch (err) {
    console.error('Google Auth Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Apply auth middleware to all protected API routes
app.use('/api/customers', authMiddleware);
app.use('/api/transactions', authMiddleware);
app.use('/api/aadhaar-cards', authMiddleware);
app.use('/api/bank-accounts', authMiddleware);
app.use('/api/modules', authMiddleware);
app.use('/api/dashboard', authMiddleware);
app.use('/api/profile', authMiddleware);
app.use('/api/backup', authMiddleware);

// ================= END AUTH ENDPOINTS =================

// Fetch Customers with Search, Combined Filters, and 10 Sort Criteria
app.get('/api/customers', async (req, res) => {

  const { search, balanceFilter, activityFilter, sortBy } = req.query;
  try {
    let baseSql = `
      SELECT c.*,
             COALESCE(latest.latest_activity, c.created_at) AS latest_activity,
             latest.oldest_activity,
             COALESCE(latest.current_balance, 0) AS current_balance,
             COALESCE(latest.total_credit, 0) AS total_credit,
             COALESCE(latest.total_debit, 0) AS total_debit,
             COALESCE(latest.total_transactions, 0) AS total_transactions
      FROM customers c
      LEFT JOIN (
        SELECT 
          t.customer_id,
          MAX(t.timestamp) AS latest_activity,
          MIN(t.timestamp) AS oldest_activity,
          SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END) AS current_balance,
          SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END) AS total_credit,
          SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END) AS total_debit,
          COUNT(*) AS total_transactions
        FROM transactions t
        GROUP BY t.customer_id
      ) AS latest ON c.id = latest.customer_id
      WHERE c.user_id = ?
    `;

    let sql = `SELECT * FROM (${baseSql}) AS cust_summary`;
    const whereClauses = [];
    const params = [req.user.id];

    // Search query (Name or Mobile)
    if (search && search.trim() !== '') {
      whereClauses.push(`(name LIKE ? OR mobile LIKE ?)`);
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }

    // Balance filters
    if (balanceFilter === 'positive') {
      whereClauses.push(`current_balance > 0`);
    } else if (balanceFilter === 'negative') {
      whereClauses.push(`current_balance < 0`);
    } else if (balanceFilter === 'zero') {
      whereClauses.push(`current_balance = 0`);
    }

    // Activity filters
    if (activityFilter === 'active') {
      whereClauses.push(`total_transactions > 0`);
    } else if (activityFilter === 'inactive') {
      whereClauses.push(`total_transactions = 0`);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ` + whereClauses.join(` AND `);
    }

    // 10 Sort Criteria
    if (sortBy === 'recently_created') {
      sql += ` ORDER BY created_at DESC`;
    } else if (sortBy === 'oldest_created') {
      sql += ` ORDER BY created_at ASC`;
    } else if (sortBy === 'name_asc') {
      sql += ` ORDER BY name ASC`;
    } else if (sortBy === 'name_desc') {
      sql += ` ORDER BY name DESC`;
    } else if (sortBy === 'highest_balance') {
      sql += ` ORDER BY current_balance DESC`;
    } else if (sortBy === 'lowest_balance') {
      sql += ` ORDER BY current_balance ASC`;
    } else if (sortBy === 'highest_credit') {
      sql += ` ORDER BY total_credit DESC`;
    } else if (sortBy === 'highest_debit') {
      sql += ` ORDER BY total_debit DESC`;
    } else if (sortBy === 'latest_transaction') {
      sql += ` ORDER BY COALESCE(latest_activity, created_at) DESC`;
    } else if (sortBy === 'oldest_transaction') {
      sql += ` ORDER BY COALESCE(oldest_activity, created_at) ASC`;
    } else {
      // Default: Latest active
      sql += ` ORDER BY COALESCE(latest_activity, created_at) DESC`;
    }

    const customers = await dbAll(sql, params);
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Customer Summary
app.get('/api/customers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const customer = await dbGet(`SELECT * FROM customers WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const summary = await dbGet(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS total_debit,
        COUNT(*) AS total_transactions,
        MAX(timestamp) AS last_transaction_date
      FROM transactions
      WHERE customer_id = ?
    `, [id]);

    const current_balance = summary.total_credit - summary.total_debit;

    res.json({
      ...customer,
      current_balance,
      total_credit: summary.total_credit,
      total_debit: summary.total_debit,
      total_transactions: summary.total_transactions || 0,
      last_transaction_date: summary.last_transaction_date || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Customer
app.post('/api/customers', async (req, res) => {
  const { name, mobile } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Customer Name is required' });
  }

  try {
    // Check duplicate name case-insensitively within user scope
    const existing = await dbGet(`SELECT id FROM customers WHERE LOWER(name) = LOWER(?) AND user_id = ?`, [name.trim(), req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'Customer Name must be unique (case-insensitive)' });
    }

    const newId = generateID('KB-CUST');
    const createdAt = getISTTimestamp();

    await dbRun(
      `INSERT INTO customers (id, name, mobile, created_at, user_id) VALUES (?, ?, ?, ?, ?)`,
      [newId, name.trim(), mobile ? mobile.trim() : null, createdAt, req.user.id]
    );

    await logActivity('customer_create', `Created customer ledger for ${name.trim()}`, req.user.id);

    const newCustomer = await dbGet(`SELECT * FROM customers WHERE id = ?`, [newId]);
    res.status(201).json(newCustomer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Customer
app.put('/api/customers/:id', async (req, res) => {
  const { id } = req.params;
  const { name, mobile } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Customer Name is required' });
  }

  try {
    const existingName = await dbGet(`SELECT id FROM customers WHERE LOWER(name) = LOWER(?) AND id != ? AND user_id = ?`, [name.trim(), id, req.user.id]);
    if (existingName) {
      return res.status(400).json({ error: 'Customer Name must be unique (case-insensitive)' });
    }

    const result = await dbRun(
      `UPDATE customers SET name = ?, mobile = ? WHERE id = ? AND user_id = ?`,
      [name.trim(), mobile ? mobile.trim() : null, id, req.user.id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    await logActivity('customer_update', `Updated details for customer ${name.trim()}`, req.user.id);

    const updated = await dbGet(`SELECT * FROM customers WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Customer
app.delete('/api/customers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const customer = await dbGet(`SELECT name FROM customers WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    await dbRun(`DELETE FROM customers WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await logActivity('customer_delete', `Deleted customer ledger for ${customer.name}`, req.user.id);
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Transactions for Customer (running balance computed globally, returned filtered/sorted)
app.get('/api/customers/:id/transactions', async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date, type, min_amount, max_amount, note_search, sortBy } = req.query;

  try {
    // Verify customer belongs to user
    const cust = await dbGet(`SELECT id FROM customers WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!cust) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const allTransactions = await dbAll(
      `SELECT * FROM transactions WHERE customer_id = ? ORDER BY timestamp ASC, id ASC`,
      [id]
    );

    // Compute running balance chronologically
    let runningBalance = 0;
    const computedTxns = allTransactions.map(txn => {
      if (txn.type === 'credit') {
        runningBalance += txn.amount;
      } else {
        runningBalance -= txn.amount;
      }
      return {
        ...txn,
        running_balance: runningBalance
      };
    });

    // Apply filters
    let filtered = computedTxns;

    if (start_date) {
      const start = `${start_date} 00:00:00`;
      filtered = filtered.filter(t => t.timestamp >= start);
    }
    if (end_date) {
      const end = `${end_date} 23:59:59`;
      filtered = filtered.filter(t => t.timestamp <= end);
    }
    if (type) {
      filtered = filtered.filter(t => t.type === type);
    }
    if (min_amount) {
      filtered = filtered.filter(t => t.amount >= parseFloat(min_amount));
    }
    if (max_amount) {
      filtered = filtered.filter(t => t.amount <= parseFloat(max_amount));
    }
    if (note_search) {
      const searchStr = note_search.toLowerCase();
      filtered = filtered.filter(t => t.note && t.note.toLowerCase().includes(searchStr));
    }

    // Handle 5 Sort Criteria for Transaction List
    if (sortBy === 'date_asc') {
      filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    } else if (sortBy === 'amount_desc') {
      filtered.sort((a, b) => b.amount - a.amount);
    } else if (sortBy === 'amount_asc') {
      filtered.sort((a, b) => a.amount - b.amount);
    } else if (sortBy === 'note_asc') {
      filtered.sort((a, b) => (a.note || '').localeCompare(b.note || ''));
    } else {
      // Default: date_desc (newest first)
      filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
    }

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Transaction
app.post('/api/transactions', async (req, res) => {
  const { customer_id, type, amount, note, timestamp } = req.body;

  if (!customer_id || !type || amount === undefined) {
    return res.status(400).json({ error: 'Missing required fields: customer_id, type, amount' });
  }

  if (type !== 'credit' && type !== 'debit') {
    return res.status(400).json({ error: "Type must be 'credit' or 'debit'" });
  }

  const amtNum = parseFloat(amount);
  if (isNaN(amtNum) || amtNum <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number greater than 0' });
  }

  try {
    const customer = await dbGet(`SELECT id, name FROM customers WHERE id = ? AND user_id = ?`, [customer_id, req.user.id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const txnId = generateID('TXN');
    let finalTimestamp = timestamp ? timestamp.trim().replace('T', ' ') : getISTTimestamp();
    if (finalTimestamp.length === 16) {
      finalTimestamp += ':00';
    }

    await dbRun(
      `INSERT INTO transactions (id, customer_id, type, amount, note, timestamp, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [txnId, customer_id, type, amtNum, note ? note.trim() : null, finalTimestamp, req.user.id]
    );

    await logActivity('transaction_create', `Added Rs.${amtNum.toFixed(2)} (${type === 'credit' ? 'Credit' : 'Debit'}) entry for customer ${customer.name}`, req.user.id);

    const newTxn = await dbGet(`SELECT * FROM transactions WHERE id = ?`, [txnId]);
    res.status(201).json(newTxn);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit Transaction
app.put('/api/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { type, amount, note, timestamp } = req.body;

  if (!type || amount === undefined) {
    return res.status(400).json({ error: 'Missing required fields: type, amount' });
  }

  if (type !== 'credit' && type !== 'debit') {
    return res.status(400).json({ error: "Type must be 'credit' or 'debit'" });
  }

  const amtNum = parseFloat(amount);
  if (isNaN(amtNum) || amtNum <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number greater than 0' });
  }

  try {
    const existingTxn = await dbGet(`SELECT * FROM transactions WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!existingTxn) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    let finalTimestamp = timestamp ? timestamp.trim().replace('T', ' ') : existingTxn.timestamp;
    if (finalTimestamp.length === 16) {
      finalTimestamp += ':00';
    }

    await dbRun(
      `UPDATE transactions SET type = ?, amount = ?, note = ?, timestamp = ? WHERE id = ? AND user_id = ?`,
      [type, amtNum, note ? note.trim() : null, finalTimestamp, id, req.user.id]
    );

    await logActivity('transaction_update', `Edited transaction entry ID ${id}: Rs.${amtNum.toFixed(2)} (${type})`, req.user.id);

    const updated = await dbGet(`SELECT * FROM transactions WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Transaction
app.delete('/api/transactions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet(`SELECT amount, type FROM transactions WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    await dbRun(`DELETE FROM transactions WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await logActivity('transaction_delete', `Deleted transaction entry ID ${id} of amount Rs.${existing.amount.toFixed(2)} (${existing.type})`, req.user.id);
    res.json({ message: 'Transaction deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Dashboard Statistics and Recent Activity
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const customerBalances = await dbAll(`
      SELECT 
        c.id,
        (SELECT COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)
         FROM transactions t WHERE t.customer_id = c.id) AS balance
      FROM customers c
      WHERE c.user_id = ?
    `, [req.user.id]);

    let totalReceivable = 0; // customer owes us (balance is negative, represent as positive)
    let totalPayable = 0;    // we owe customer (balance is positive)
    
    customerBalances.forEach(c => {
      if (c.balance < 0) {
        totalReceivable += Math.abs(c.balance);
      } else if (c.balance > 0) {
        totalPayable += c.balance;
      }
    });

    const counts = await dbGet(`
      SELECT 
        (SELECT COUNT(*) FROM customers WHERE user_id = ?) AS total_customers,
        (SELECT COUNT(*) FROM transactions WHERE user_id = ?) AS total_transactions,
        (SELECT COUNT(DISTINCT customer_id) FROM transactions WHERE user_id = ?) AS active_customers
    `, [req.user.id, req.user.id, req.user.id]);

    const recentTransactions = await dbAll(`
      SELECT t.*, c.name AS customer_name
      FROM transactions t
      JOIN customers c ON t.customer_id = c.id
      WHERE t.user_id = ?
      ORDER BY t.timestamp DESC, t.id DESC
      LIMIT 5
    `, [req.user.id]);

    res.json({
      totalReceivable,
      totalPayable,
      netBalance: totalPayable - totalReceivable,
      totalCustomers: counts.total_customers,
      totalTransactions: counts.total_transactions,
      activeCustomers: counts.active_customers,
      recentTransactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Modules
app.get('/api/modules', async (req, res) => {
  try {
    const modules = await dbAll(`SELECT * FROM modules`);
    res.json(modules);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= AADHAAR CARDS API =================

// Fetch all Aadhaar cards
app.get('/api/aadhaar-cards', async (req, res) => {
  const { search } = req.query;
  try {
    let sql = `SELECT * FROM aadhaar_cards WHERE user_id = ?`;
    const params = [req.user.id];
    
    if (search && search.trim() !== '') {
      sql += ` AND (holder_name LIKE ? OR aadhaar_number LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term);
    }
    
    sql += ` ORDER BY created_at DESC`;
    const cards = await dbAll(sql, params);
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single Aadhaar card
app.get('/api/aadhaar-cards/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const card = await dbGet(`SELECT * FROM aadhaar_cards WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!card) {
      return res.status(404).json({ error: 'Aadhaar card not found' });
    }
    res.json(card);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Aadhaar card
app.post('/api/aadhaar-cards', async (req, res) => {
  const { holder_name, aadhaar_number, image } = req.body;
  
  if (!holder_name || !holder_name.trim()) {
    return res.status(400).json({ error: 'Holder name is required' });
  }
  if (!aadhaar_number || !aadhaar_number.trim()) {
    return res.status(400).json({ error: 'Aadhaar number is required' });
  }
  
  try {
    const newId = generateID('AAD');
    const now = getISTTimestamp();
    
    await dbRun(
      `INSERT INTO aadhaar_cards (id, holder_name, aadhaar_number, image, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId, holder_name.trim(), aadhaar_number.trim(), image || null, now, now, req.user.id]
    );
    
    await logActivity('aadhaar_create', `Added Aadhaar card for ${holder_name.trim()}`, req.user.id);
    
    const card = await dbGet(`SELECT * FROM aadhaar_cards WHERE id = ? AND user_id = ?`, [newId, req.user.id]);
    res.status(201).json(card);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Aadhaar card
app.put('/api/aadhaar-cards/:id', async (req, res) => {
  const { id } = req.params;
  const { holder_name, aadhaar_number, image } = req.body;
  
  if (!holder_name || !holder_name.trim()) {
    return res.status(400).json({ error: 'Holder name is required' });
  }
  if (!aadhaar_number || !aadhaar_number.trim()) {
    return res.status(400).json({ error: 'Aadhaar number is required' });
  }
  
  try {
    const existing = await dbGet(`SELECT * FROM aadhaar_cards WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Aadhaar card not found' });
    }
    
    const now = getISTTimestamp();
    const finalImage = image !== undefined ? image : existing.image;
    
    await dbRun(
      `UPDATE aadhaar_cards SET holder_name = ?, aadhaar_number = ?, image = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [holder_name.trim(), aadhaar_number.trim(), finalImage, now, id, req.user.id]
    );
    
    await logActivity('aadhaar_update', `Updated Aadhaar card details for ${holder_name.trim()}`, req.user.id);
    
    const updated = await dbGet(`SELECT * FROM aadhaar_cards WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Aadhaar card
app.delete('/api/aadhaar-cards/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet(`SELECT holder_name FROM aadhaar_cards WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Aadhaar card not found' });
    }
    await dbRun(`DELETE FROM aadhaar_cards WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await logActivity('aadhaar_delete', `Deleted Aadhaar card for ${existing.holder_name}`, req.user.id);
    res.json({ message: 'Aadhaar card deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= BANK ACCOUNTS API =================

// Fetch all Bank Accounts
app.get('/api/bank-accounts', async (req, res) => {
  const { search } = req.query;
  try {
    let sql = `SELECT * FROM bank_accounts WHERE user_id = ?`;
    const params = [req.user.id];
    
    if (search && search.trim() !== '') {
      sql += ` AND (account_holder LIKE ? OR account_number LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term);
    }
    
    sql += ` ORDER BY created_at DESC`;
    const accounts = await dbAll(sql, params);
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single Bank Account
app.get('/api/bank-accounts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const account = await dbGet(`SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!account) {
      return res.status(404).json({ error: 'Bank account not found' });
    }
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Bank Account
app.post('/api/bank-accounts', async (req, res) => {
  const { account_holder, account_number, image } = req.body;
  
  if (!account_holder || !account_holder.trim()) {
    return res.status(400).json({ error: 'Account holder name is required' });
  }
  if (!account_number || !account_number.trim()) {
    return res.status(400).json({ error: 'Account number is required' });
  }
  
  try {
    const newId = generateID('BNK');
    const now = getISTTimestamp();
    
    await dbRun(
      `INSERT INTO bank_accounts (id, account_holder, account_number, image, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId, account_holder.trim(), account_number.trim(), image || null, now, now, req.user.id]
    );
    
    await logActivity('bank_create', `Added bank account for ${account_holder.trim()}`, req.user.id);
    
    const account = await dbGet(`SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?`, [newId, req.user.id]);
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Bank Account
app.put('/api/bank-accounts/:id', async (req, res) => {
  const { id } = req.params;
  const { account_holder, account_number, image } = req.body;
  
  if (!account_holder || !account_holder.trim()) {
    return res.status(400).json({ error: 'Account holder name is required' });
  }
  if (!account_number || !account_number.trim()) {
    return res.status(400).json({ error: 'Account number is required' });
  }
  
  try {
    const existing = await dbGet(`SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Bank account not found' });
    }
    
    const now = getISTTimestamp();
    const finalImage = image !== undefined ? image : existing.image;
    
    await dbRun(
      `UPDATE bank_accounts SET account_holder = ?, account_number = ?, image = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [account_holder.trim(), account_number.trim(), finalImage, now, id, req.user.id]
    );
    
    await logActivity('bank_update', `Updated bank account details for ${account_holder.trim()}`, req.user.id);
    
    const updated = await dbGet(`SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Bank Account
app.delete('/api/bank-accounts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet(`SELECT account_holder FROM bank_accounts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Bank account not found' });
    }
    await dbRun(`DELETE FROM bank_accounts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await logActivity('bank_delete', `Deleted bank account for ${existing.account_holder}`, req.user.id);
    res.json({ message: 'Bank account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PDF Statement Generator with double columns, split date/time, and fixed Rupee symbol bug (using Rs.)
app.get('/api/customers/:id/statement', async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date } = req.query;

  try {
    const customer = await dbGet(`SELECT * FROM customers WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!customer) {
      return res.status(404).send('Customer not found');
    }

    const allTransactions = await dbAll(
      `SELECT * FROM transactions WHERE customer_id = ? ORDER BY timestamp ASC, id ASC`,
      [id]
    );

    let runningBalance = 0;
    let openingBalance = 0;
    let periodCredits = 0;
    let periodDebits = 0;

    const startFilter = start_date ? `${start_date} 00:00:00` : null;
    const endFilter = end_date ? `${end_date} 23:59:59` : null;

    const processedTxns = [];

    for (const txn of allTransactions) {
      const isBeforePeriod = startFilter && txn.timestamp < startFilter;
      const isAfterPeriod = endFilter && txn.timestamp > endFilter;

      if (txn.type === 'credit') {
        runningBalance += txn.amount;
        if (!isBeforePeriod && !isAfterPeriod) {
          periodCredits += txn.amount;
        }
      } else {
        runningBalance -= txn.amount;
        if (!isBeforePeriod && !isAfterPeriod) {
          periodDebits += txn.amount;
        }
      }

      if (isBeforePeriod) {
        openingBalance = runningBalance;
      }

      if ((!startFilter || txn.timestamp >= startFilter) && (!endFilter || txn.timestamp <= endFilter)) {
        processedTxns.push({
          ...txn,
          running_balance: runningBalance
        });
      }
    }

    const closingBalance = openingBalance + periodCredits - periodDebits;
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    const filename = `${customer.name.replace(/\s+/g, '_')}_statement.pdf`;
    res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-type', 'application/pdf');

    doc.pipe(res);

    // --- Elegant Header Section ---
    // Top colored brand bar
    doc.rect(40, 30, 515, 3).fill('#4F46E5');

    // Brand Name and Subtitle (Left Side)
    doc.fillColor('#4F46E5').font('Helvetica-Bold').fontSize(16).text('SRIRAMA KHATABOOK', 40, 48);
    doc.fillColor('#64748B').font('Helvetica').fontSize(9).text('Your Trusted Ledger Manager', 40, 68);

    // Statement title and Date (Right Side)
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(13).text('ACCOUNT STATEMENT', 310, 48, { width: 245, align: 'right' });
    const periodText = start_date && end_date ? `${start_date} to ${end_date}` : 'All Time';
    doc.fillColor('#64748B').font('Helvetica').fontSize(9).text(`Statement Period: ${periodText}`, 310, 68, { width: 245, align: 'right' });

    // Header divider line
    doc.strokeColor('#E2E8F0').lineWidth(0.5).moveTo(40, 88).lineTo(555, 88).stroke();

    // --- Customer & Account Cards (2-Column Grid) ---
    const cardY = 102;
    const cardHeight = 78;

    // Left Card (Customer Details)
    doc.roundedRect(40, cardY, 245, cardHeight, 6).fill('#F8FAFC');
    doc.roundedRect(40, cardY, 245, cardHeight, 6).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.5).text('STATEMENT FOR', 52, cardY + 10);
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text(customer.name, 52, cardY + 22, { width: 220, ellipsis: true });
    doc.fillColor('#475569').font('Helvetica').fontSize(8.5).text(`Mobile: ${customer.mobile || 'N/A'}`, 52, cardY + 40);
    doc.fillColor('#64748B').font('Helvetica').fontSize(8).text(`Customer ID: ${customer.id}`, 52, cardY + 54);

    // Right Card (Account Metadata)
    doc.roundedRect(310, cardY, 245, cardHeight, 6).fill('#F8FAFC');
    doc.roundedRect(310, cardY, 245, cardHeight, 6).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.5).text('ACCOUNT DETAILS', 322, cardY + 10);
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10).text(`Ledger ID: ${customer.id}`, 322, cardY + 22);
    doc.fillColor('#475569').font('Helvetica').fontSize(8.5).text(`Account Opened: ${customer.created_at} IST`, 322, cardY + 40);
    doc.fillColor('#64748B').font('Helvetica').fontSize(8.5).text(`Generated On: ${getISTTimestamp()} IST`, 322, cardY + 54);

    // --- Financial Summary Cards (4 Columns side-by-side) ---
    const summaryY = 196;
    const summaryHeight = 52;
    const cardW = 120;
    const gap = 11.6;

    // 1. Opening Balance Card (Slate Theme)
    doc.roundedRect(40, summaryY, cardW, summaryHeight, 6).fill('#F8FAFC');
    doc.roundedRect(40, summaryY, cardW, summaryHeight, 6).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
    doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(7).text('OPENING BALANCE', 40, summaryY + 11, { width: cardW, align: 'center' });
    doc.fillColor('#334155').font('Helvetica-Bold').fontSize(11).text(`Rs. ${openingBalance.toFixed(2)}`, 40, summaryY + 26, { width: cardW, align: 'center' });

    // 2. Total Credits Card (Green Theme)
    const creditsX = 40 + cardW + gap;
    doc.roundedRect(creditsX, summaryY, cardW, summaryHeight, 6).fill('#E6F4EA');
    doc.roundedRect(creditsX, summaryY, cardW, summaryHeight, 6).lineWidth(0.5).strokeColor('#A3E635').stroke();
    doc.fillColor('#137333').font('Helvetica-Bold').fontSize(7).text('TOTAL CREDITS (+)', creditsX, summaryY + 11, { width: cardW, align: 'center' });
    doc.fillColor('#137333').font('Helvetica-Bold').fontSize(11).text(`Rs. ${periodCredits.toFixed(2)}`, creditsX, summaryY + 26, { width: cardW, align: 'center' });

    // 3. Total Debits Card (Red Theme)
    const debitsX = 40 + 2 * (cardW + gap);
    doc.roundedRect(debitsX, summaryY, cardW, summaryHeight, 6).fill('#FCE8E6');
    doc.roundedRect(debitsX, summaryY, cardW, summaryHeight, 6).lineWidth(0.5).strokeColor('#FCA5A5').stroke();
    doc.fillColor('#C5221F').font('Helvetica-Bold').fontSize(7).text('TOTAL DEBITS (-)', debitsX, summaryY + 11, { width: cardW, align: 'center' });
    doc.fillColor('#C5221F').font('Helvetica-Bold').fontSize(11).text(`Rs. ${periodDebits.toFixed(2)}`, debitsX, summaryY + 26, { width: cardW, align: 'center' });

    // 4. Net Balance Card (Status Colored Theme)
    const netX = 40 + 3 * (cardW + gap);
    const isNetOwed = closingBalance < 0;
    const netColor = isNetOwed ? '#C5221F' : (closingBalance > 0 ? '#137333' : '#334155');
    const netBg = isNetOwed ? '#FCE8E6' : (closingBalance > 0 ? '#E6F4EA' : '#F8FAFC');
    const netBorder = isNetOwed ? '#FCA5A5' : (closingBalance > 0 ? '#A3E635' : '#E2E8F0');
    const netStatusText = isNetOwed ? 'YOU WILL GET' : (closingBalance > 0 ? 'YOU WILL GIVE' : 'SETTLED');

    doc.roundedRect(netX, summaryY, cardW, summaryHeight, 6).fill(netBg);
    doc.roundedRect(netX, summaryY, cardW, summaryHeight, 6).lineWidth(0.5).strokeColor(netBorder).stroke();
    doc.fillColor(netColor).font('Helvetica-Bold').fontSize(7).text('NET BALANCE', netX, summaryY + 9, { width: cardW, align: 'center' });
    doc.fillColor(netColor).font('Helvetica-Bold').fontSize(11).text(`Rs. ${Math.abs(closingBalance).toFixed(2)}`, netX, summaryY + 22, { width: cardW, align: 'center' });
    doc.fillColor('#5F6368').font('Helvetica-Bold').fontSize(6).text(netStatusText, netX, summaryY + 36, { width: cardW, align: 'center' });

    // --- Transaction Ledger Table Section ---
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10).text('TRANSACTION LEDGER', 40, 270);

    // Table Header
    const tableHeaderY = 286;
    doc.rect(40, tableHeaderY, 515, 20).fill('#4F46E5');
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
    
    doc.text('Date', 45, tableHeaderY + 6, { width: 65 });
    doc.text('Time', 120, tableHeaderY + 6, { width: 50 });
    doc.text('Type', 165, tableHeaderY + 6, { width: 50 });
    doc.text('Description / Notes', 220, tableHeaderY + 6, { width: 130 });
    doc.text('Credit (In)', 355, tableHeaderY + 6, { width: 60, align: 'right' });
    doc.text('Debit (Out)', 420, tableHeaderY + 6, { width: 60, align: 'right' });
    doc.text('Balance', 485, tableHeaderY + 6, { width: 65, align: 'right' });

    doc.y = tableHeaderY + 20;

    // Table Rows
    doc.font('Helvetica').fontSize(8).fillColor('#334155');
    let alternatedRow = false;

    // Standard chronological statement (oldest first)
    processedTxns.reverse(); 
    
    for (const txn of processedTxns) {
      const noteText = txn.note || '-';
      const noteHeight = doc.heightOfString(noteText, { width: 130 });
      const rowHeight = Math.max(18, noteHeight + 10);

      // Page overflow check (with 40pt margin at bottom)
      if (doc.y + rowHeight > 780) {
        doc.addPage();
        const newPageHeaderY = 40;
        doc.rect(40, newPageHeaderY, 515, 20).fill('#4F46E5');
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
        doc.text('Date', 45, newPageHeaderY + 6, { width: 65 });
        doc.text('Time', 120, newPageHeaderY + 6, { width: 50 });
        doc.text('Type', 165, newPageHeaderY + 6, { width: 50 });
        doc.text('Description / Notes', 220, newPageHeaderY + 6, { width: 130 });
        doc.text('Credit (In)', 355, newPageHeaderY + 6, { width: 60, align: 'right' });
        doc.text('Debit (Out)', 420, newPageHeaderY + 6, { width: 60, align: 'right' });
        doc.text('Balance', 485, newPageHeaderY + 6, { width: 65, align: 'right' });
        doc.y = newPageHeaderY + 20;
        doc.font('Helvetica').fontSize(8).fillColor('#334155');
      }

      const rowY = doc.y;
      if (alternatedRow) {
        doc.rect(40, rowY, 515, rowHeight).fill('#F8FAFC');
        doc.fillColor('#334155');
      } else {
        doc.fillColor('#334155');
      }

      // Split Date and Time
      const dateStr = txn.timestamp.substring(0, 10);
      let timeStr = txn.timestamp.substring(11, 16);
      try {
        const [hStr, mStr] = timeStr.split(':');
        const hVal = parseInt(hStr, 10);
        const ampmVal = hVal >= 12 ? 'PM' : 'AM';
        const h12Val = hVal % 12 || 12;
        const padHour = String(h12Val).padStart(2, '0');
        timeStr = `${padHour}:${mStr} ${ampmVal}`;
      } catch (e) {
        // fallback
      }

      doc.fillColor('#334155').font('Helvetica');
      doc.text(dateStr, 45, rowY + 5, { width: 65 });
      doc.text(timeStr, 120, rowY + 5, { width: 50 });
      
      const isCredit = txn.type === 'credit';
      doc.fillColor(isCredit ? '#137333' : '#C5221F').font('Helvetica-Bold');
      doc.text(isCredit ? 'Credit' : 'Debit', 165, rowY + 5, { width: 50 });
      
      doc.fillColor('#334155').font('Helvetica');
      doc.text(noteText, 220, rowY + 5, { width: 130 });
      
      // Credit / Debit Double Column amounts
      if (isCredit) {
        doc.fillColor('#137333').font('Helvetica-Bold');
        doc.text(`+ Rs. ${txn.amount.toFixed(2)}`, 355, rowY + 5, { width: 60, align: 'right' });
        doc.fillColor('#94A3B8').font('Helvetica');
        doc.text('-', 420, rowY + 5, { width: 60, align: 'right' });
      } else {
        doc.fillColor('#94A3B8').font('Helvetica');
        doc.text('-', 355, rowY + 5, { width: 60, align: 'right' });
        doc.fillColor('#C5221F').font('Helvetica-Bold');
        doc.text(`- Rs. ${txn.amount.toFixed(2)}`, 420, rowY + 5, { width: 60, align: 'right' });
      }
      
      // Running Balance
      doc.fillColor(txn.running_balance < 0 ? '#C5221F' : '#137333').font('Helvetica-Bold');
      const formattedBalance = txn.running_balance < 0 
        ? `- Rs. ${Math.abs(txn.running_balance).toFixed(2)}`
        : `Rs. ${txn.running_balance.toFixed(2)}`;
      doc.text(formattedBalance, 485, rowY + 5, { width: 65, align: 'right' });

      doc.y = rowY + rowHeight;
      alternatedRow = !alternatedRow;
    }

    // Footer Page Numbers
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor('#94A3B8').text(
        `Khata Book statement generated for ${customer.name}. Page ${i + 1} of ${pageCount}`, 
        40, 
        805, 
        { align: 'center', width: 515 }
      );
    }

    doc.end();
  } catch (error) {
    res.status(500).send(`Error generating statement: ${error.message}`);
  }
});

async function logActivity(eventType, description, userId) {
  try {
    const id = generateID('LOG');
    const now = getISTTimestamp();
    const uid = userId || null;
    await dbRun(`INSERT INTO activity_logs (id, event_type, description, timestamp, user_id) VALUES (?, ?, ?, ?, ?)`, [id, eventType, description, now, uid]);
    // Auto-cleanup: keep only last 90 days of logs for this user
    if (uid) {
      await dbRun(`DELETE FROM activity_logs WHERE user_id = ? AND timestamp < date('now', '-90 days')`, [uid]);
    }
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

app.get('/api/profile', async (req, res) => {
  try {
    const profile = await dbGet(`SELECT * FROM user_profile WHERE id = ?`, [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const profileCopy = { ...profile };
    delete profileCopy.password;
    res.json(profileCopy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy login-event (kept for backwards compat — new auth uses /api/login)
app.post('/api/login-event', async (req, res) => {
  res.json({ success: true });
});

// Legacy logout-event (kept for backwards compat — new auth uses /api/logout)
app.post('/api/logout-event', async (req, res) => {
  res.json({ success: true });
});

app.put('/api/profile', async (req, res) => {
  const { name, email, mobile, profile_picture, timezone, theme, language, notification_transactions, notification_backup, notification_system, notification_reminder, backup_schedule, backup_time } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Name is required' });
  }
  try {
    const now = getISTTimestamp();
    await dbRun(`
      UPDATE user_profile SET 
        name = ?, email = ?, mobile = ?, profile_picture = ?, timezone = ?, theme = ?, language = ?, 
        notification_transactions = ?, notification_backup = ?, notification_system = ?, notification_reminder = ?,
        backup_schedule = ?, backup_time = ?,
        updated_at = ?
      WHERE id = ?
    `, [
      name.trim(), email ? email.trim() : req.user.email, mobile ? mobile.trim() : '', 
      profile_picture !== undefined ? profile_picture : req.user.profile_picture,
      timezone || 'Asia/Kolkata', theme || 'system', language || 'en',
      notification_transactions !== undefined ? (notification_transactions ? 1 : 0) : 1,
      notification_backup !== undefined ? (notification_backup ? 1 : 0) : 1,
      notification_system !== undefined ? (notification_system ? 1 : 0) : 1,
      notification_reminder !== undefined ? (notification_reminder ? 1 : 0) : 1,
      backup_schedule || 'manual', backup_time || '00:00',
      now,
      req.user.id
    ]);
    await logActivity('profile_update', `Updated profile settings for ${name.trim()}`, req.user.id);
    const updated = await dbGet(`SELECT * FROM user_profile WHERE id = ?`, [req.user.id]);
    delete updated.password;
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/profile/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  try {
    const profileRow = await dbGet(`SELECT password FROM user_profile WHERE id = ?`, [req.user.id]);
    const valid = isPasswordHashed(profileRow.password)
      ? verifyPassword(currentPassword, profileRow.password)
      : profileRow.password === currentPassword;
    if (!valid) {
      return res.status(400).json({ error: 'Incorrect current password' });
    }
    const now = getISTTimestamp();
    const hashed = hashPassword(newPassword);
    await dbRun(`UPDATE user_profile SET password = ?, updated_at = ? WHERE id = ?`, [hashed, now, req.user.id]);
    await logActivity('profile_update', 'Password changed successfully', req.user.id);
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profile/activity', async (req, res) => {
  try {
    const logs = await dbAll(`SELECT * FROM activity_logs WHERE user_id = ? ORDER BY timestamp DESC, id DESC LIMIT 50`, [req.user.id]);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backup/export/customers', authMiddleware, async (req, res) => {
  try {
    const customers = await dbAll(`SELECT * FROM customers WHERE user_id = ? ORDER BY name ASC`, [req.user.id]);
    let csv = 'ID,Name,Mobile,CreatedAt\r\n';
    customers.forEach(c => {
      csv += `"${c.id}","${(c.name || '').replace(/"/g, '""')}","${c.mobile || ''}","${c.created_at}"\r\n`;
    });
    res.setHeader('Content-disposition', 'attachment; filename=customers_export.csv');
    res.setHeader('Content-type', 'text/csv');
    res.send(csv);
    await logActivity('backup_export', 'Exported customers database to CSV', req.user.id);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/backup/export/transactions', authMiddleware, async (req, res) => {
  try {
    const txns = await dbAll(`SELECT t.*, c.name as customer_name FROM transactions t JOIN customers c ON t.customer_id = c.id WHERE t.user_id = ? ORDER BY t.timestamp DESC`, [req.user.id]);
    let csv = 'ID,CustomerID,CustomerName,Type,Amount,Note,Timestamp\r\n';
    txns.forEach(t => {
      csv += `"${t.id}","${t.customer_id}","${(t.customer_name || '').replace(/"/g, '""')}","${t.type}",${t.amount},"${(t.note || '').replace(/"/g, '""')}","${t.timestamp}"\r\n`;
    });
    res.setHeader('Content-disposition', 'attachment; filename=transactions_export.csv');
    res.setHeader('Content-type', 'text/csv');
    res.send(csv);
    await logActivity('backup_export', 'Exported transactions database to CSV', req.user.id);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/backup/export/aadhaar', authMiddleware, async (req, res) => {
  try {
    const cards = await dbAll(`SELECT id, holder_name, aadhaar_number, created_at, updated_at FROM aadhaar_cards WHERE user_id = ? ORDER BY created_at DESC`, [req.user.id]);
    let csv = 'ID,HolderName,AadhaarNumber,CreatedAt,UpdatedAt\r\n';
    cards.forEach(c => {
      csv += `"${c.id}","${(c.holder_name || '').replace(/"/g, '""')}","${c.aadhaar_number}","${c.created_at}","${c.updated_at}"\r\n`;
    });
    res.setHeader('Content-disposition', 'attachment; filename=aadhaar_export.csv');
    res.setHeader('Content-type', 'text/csv');
    res.send(csv);
    await logActivity('backup_export', 'Exported Aadhaar cards list to CSV', req.user.id);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/backup/export/bank', authMiddleware, async (req, res) => {
  try {
    const accounts = await dbAll(`SELECT id, account_holder, account_number, created_at, updated_at FROM bank_accounts WHERE user_id = ? ORDER BY created_at DESC`, [req.user.id]);
    let csv = 'ID,AccountHolder,AccountNumber,CreatedAt,UpdatedAt\r\n';
    accounts.forEach(a => {
      csv += `"${a.id}","${(a.account_holder || '').replace(/"/g, '""')}","${a.account_number}","${a.created_at}","${a.updated_at}"\r\n`;
    });
    res.setHeader('Content-disposition', 'attachment; filename=bank_accounts_export.csv');
    res.setHeader('Content-type', 'text/csv');
    res.send(csv);
    await logActivity('backup_export', 'Exported Bank accounts list to CSV', req.user.id);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/backup/export/complete', authMiddleware, async (req, res) => {
  try {
    const profile = await dbGet(`SELECT * FROM user_profile WHERE id = ?`, [req.user.id]);
    const customers = await dbAll(`SELECT * FROM customers WHERE user_id = ?`, [req.user.id]);
    const transactions = await dbAll(`SELECT * FROM transactions WHERE user_id = ?`, [req.user.id]);
    const aadhaar = await dbAll(`SELECT * FROM aadhaar_cards WHERE user_id = ?`, [req.user.id]);
    const bank = await dbAll(`SELECT * FROM bank_accounts WHERE user_id = ?`, [req.user.id]);
    const logs = await dbAll(`SELECT * FROM activity_logs WHERE user_id = ?`, [req.user.id]);
    
    const backupData = {
      version: '1.0.0',
      timestamp: getISTTimestamp(),
      user_profile: profile ? [profile] : [],
      customers: customers,
      transactions: transactions,
      aadhaar_cards: aadhaar,
      bank_accounts: bank,
      activity_logs: logs
    };
    
    res.setHeader('Content-disposition', 'attachment; filename=khatabook_complete_backup.json');
    res.setHeader('Content-type', 'application/json');
    res.send(JSON.stringify(backupData, null, 2));
    await logActivity('backup_export', 'Exported a complete JSON backup of the system', req.user.id);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// ================= BACKUP & RESTORE API ENDPOINTS =================

// Get backup history log
app.get('/api/backup/history', authMiddleware, async (req, res) => {
  try {
    const history = await dbAll(
      `SELECT id, timestamp, type, status, size, filepath, error_message FROM backup_history WHERE user_id = ? ORDER BY timestamp DESC`,
      [req.user.id]
    );
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Run a manual backup
app.post('/api/backup/run', authMiddleware, async (req, res) => {
  try {
    const result = await createBackup(req.user, 'manual');
    if (result.status === 'success') {
      res.json({ success: true, message: 'Backup created and sent successfully!' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to complete backup.' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download a backup ZIP file
app.get('/api/backup/download/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const backup = await dbGet(`SELECT * FROM backup_history WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!backup) {
      return res.status(404).json({ error: 'Backup record not found' });
    }
    const filePath = path.join(__dirname, 'backups', backup.filepath);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Backup file does not exist on server' });
    }
    res.download(filePath, backup.filepath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resend backup ZIP via email
app.post('/api/backup/resend/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const backup = await dbGet(`SELECT * FROM backup_history WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!backup) {
      return res.status(404).json({ error: 'Backup record not found' });
    }
    const filePath = path.join(__dirname, 'backups', backup.filepath);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Backup file does not exist on server' });
    }
    
    await sendBackupEmail(req.user.email, filePath, backup.filepath);
    
    // If it was failed, update status to success
    if (backup.status === 'failed') {
      await dbRun(`UPDATE backup_history SET status = 'success', error_message = NULL WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    }
    
    res.json({ success: true, message: 'Backup email sent successfully!' });
  } catch (error) {
    await dbRun(`UPDATE backup_history SET status = 'failed', error_message = ? WHERE id = ? AND user_id = ?`, [error.message, id, req.user.id]);
    res.status(500).json({ error: error.message });
  }
});

// Delete a backup from history and file system
app.delete('/api/backup/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const backup = await dbGet(`SELECT * FROM backup_history WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!backup) {
      return res.status(404).json({ error: 'Backup record not found' });
    }
    const filePath = path.join(__dirname, 'backups', backup.filepath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    await dbRun(`DELETE FROM backup_history WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ success: true, message: 'Backup deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Restore backup from uploaded ZIP (Base64)
app.post('/api/backup/restore', authMiddleware, async (req, res) => {
  const { fileContent } = req.body;
  if (!fileContent) {
    return res.status(400).json({ error: 'No file content provided' });
  }

  try {
    const buffer = Buffer.from(fileContent, 'base64');
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const tempZipFilename = `temp_restore_${Date.now()}.zip`;
    const tempZipPath = path.join(backupsDir, tempZipFilename);

    fs.writeFileSync(tempZipPath, buffer);

    await restoreBackup(tempZipFilename, req.user.id);

    // Clean up temp zip
    if (fs.existsSync(tempZipPath)) {
      fs.unlinkSync(tempZipPath);
    }

    await logActivity('backup_restore', `Database restored from manual zip upload`, req.user.id);
    res.json({ success: true, message: 'Database restored successfully! The application will now reload.' });
  } catch (error) {
    console.error('Restore backup error:', error);
    res.status(500).json({ error: error.message || 'Restoration failed' });
  }
});

// Start server and initialize database
async function initDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT
    )
  `);

  // Seed/update modules to active
  const activeModules = [
    { id: 'khata-book', name: 'Khata Book', icon: 'notebook', status: 'active', description: 'Track credits and debits per customer with running balances, filters, and PDF statements.' },
    { id: 'aadhaar-cards', name: 'Aadhaar Cards', icon: 'id-card', status: 'active', description: 'Store Aadhaar card details, upload photos, and quickly copy card information.' },
    { id: 'bank-accounts', name: 'Bank Accounts', icon: 'landmark', status: 'active', description: 'Manage bank account details, store account photos, and copy account information.' },
  ];
  for (const mod of activeModules) {
    await dbRun(`INSERT INTO modules (id, name, icon, status, description) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'active', icon = ?, description = ?`,
      [mod.id, mod.name, mod.icon, mod.status, mod.description, mod.icon, mod.description]);
  }
  
  // Clean up old entries (migration)
  await dbRun(`DELETE FROM modules WHERE id IN ('khata_book', 'aadhaar_cards', 'bank_accounts', 'katha-book')`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      mobile TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS aadhaar_cards (
      id TEXT PRIMARY KEY,
      holder_name TEXT NOT NULL,
      aadhaar_number TEXT NOT NULL,
      image TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      account_holder TEXT NOT NULL,
      account_number TEXT NOT NULL,
      image TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT,
      role TEXT NOT NULL,
      email TEXT NOT NULL,
      mobile TEXT,
      profile_picture TEXT,
      password TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      theme TEXT NOT NULL DEFAULT 'system',
      language TEXT NOT NULL DEFAULT 'en',
      notification_transactions INTEGER DEFAULT 1,
      notification_backup INTEGER DEFAULT 1,
      notification_system INTEGER DEFAULT 1,
      notification_reminder INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login TEXT
    )
  `);

  // Migration: add username column if it doesn't exist
  try {
    await dbRun(`ALTER TABLE user_profile ADD COLUMN username TEXT`);
    console.log('[Migration] Added username column to user_profile');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add google_id column if it doesn't exist
  try {
    await dbRun(`ALTER TABLE user_profile ADD COLUMN google_id TEXT`);
    console.log('[Migration] Added google_id column to user_profile');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add backup_schedule column if it doesn't exist
  try {
    await dbRun(`ALTER TABLE user_profile ADD COLUMN backup_schedule TEXT DEFAULT 'manual'`);
    console.log('[Migration] Added backup_schedule column to user_profile');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add backup_time column if it doesn't exist
  try {
    await dbRun(`ALTER TABLE user_profile ADD COLUMN backup_time TEXT DEFAULT '00:00'`);
    console.log('[Migration] Added backup_time column to user_profile');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add last_backup_timestamp column if it doesn't exist
  try {
    await dbRun(`ALTER TABLE user_profile ADD COLUMN last_backup_timestamp TEXT`);
    console.log('[Migration] Added last_backup_timestamp column to user_profile');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add user_id to customers table
  try {
    await dbRun(`ALTER TABLE customers ADD COLUMN user_id TEXT`);
    console.log('[Migration] Added user_id column to customers');
    await dbRun(`UPDATE customers SET user_id = (SELECT id FROM user_profile LIMIT 1) WHERE user_id IS NULL`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add user_id to transactions table
  try {
    await dbRun(`ALTER TABLE transactions ADD COLUMN user_id TEXT`);
    console.log('[Migration] Added user_id column to transactions');
    await dbRun(`UPDATE transactions SET user_id = (SELECT id FROM user_profile LIMIT 1) WHERE user_id IS NULL`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add user_id to aadhaar_cards table
  try {
    await dbRun(`ALTER TABLE aadhaar_cards ADD COLUMN user_id TEXT`);
    console.log('[Migration] Added user_id column to aadhaar_cards');
    await dbRun(`UPDATE aadhaar_cards SET user_id = (SELECT id FROM user_profile LIMIT 1) WHERE user_id IS NULL`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add user_id to bank_accounts table
  try {
    await dbRun(`ALTER TABLE bank_accounts ADD COLUMN user_id TEXT`);
    console.log('[Migration] Added user_id column to bank_accounts');
    await dbRun(`UPDATE bank_accounts SET user_id = (SELECT id FROM user_profile LIMIT 1) WHERE user_id IS NULL`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add user_id to activity_logs table
  try {
    await dbRun(`ALTER TABLE activity_logs ADD COLUMN user_id TEXT`);
    console.log('[Migration] Added user_id column to activity_logs');
    await dbRun(`UPDATE activity_logs SET user_id = (SELECT id FROM user_profile LIMIT 1) WHERE user_id IS NULL`);
  } catch (e) {
    // Column already exists, ignore
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES user_profile(id) ON DELETE CASCADE
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      description TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS backup_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      size INTEGER NOT NULL,
      filepath TEXT NOT NULL,
      error_message TEXT,
      FOREIGN KEY(user_id) REFERENCES user_profile(id) ON DELETE CASCADE
    )
  `);

  // Seed default user if no users exist
  const profileCount = await dbGet(`SELECT COUNT(*) as count FROM user_profile`);
  if (profileCount.count === 0) {
    const now = getISTTimestamp();
    const hashedDefault = hashPassword('admin123');
    await dbRun(`
      INSERT INTO user_profile (
        id, name, username, role, email, mobile, password, timezone, theme, language, created_at, updated_at, last_login
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ['user_1', 'KhataBook Owner', 'owner', 'Owner', 'owner@khatabook.com', '', hashedDefault, 'Asia/Kolkata', 'system', 'en', now, now, now]);
    console.log('[Seed] Created default admin user (email: owner@khatabook.com, password: admin123)');
  } else {
    // Migrate: set username for existing users that have no username
    await dbRun(`UPDATE user_profile SET username = 'owner' WHERE username IS NULL AND id = 'user_1'`);
    
    // Migrate: hash any plain-text passwords
    const users = await dbAll(`SELECT id, password FROM user_profile`);
    for (const u of users) {
      if (u.password && !isPasswordHashed(u.password)) {
        const hashed = hashPassword(u.password);
        await dbRun(`UPDATE user_profile SET password = ? WHERE id = ?`, [hashed, u.id]);
        console.log(`[Migration] Hashed password for user ${u.id}`);
      }
    }
  }
}

initDatabase().then(() => {
  // Validate critical config
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (smtpUser && !smtpPass) {
    console.warn('[WARN] SMTP_USER is set but SMTP_PASS is empty. Backup emails will fail. Set SMTP_PASS in .env');
  }
  if (smtpPass && !smtpUser) {
    console.warn('[WARN] SMTP_PASS is set but SMTP_USER is empty. Backup emails will fail. Set SMTP_USER in .env');
  }
  initBackupScheduler();
  app.listen(PORT, () => {
    console.log(`Khata Book server is running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
});
