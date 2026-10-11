const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');

const dbConfig = {
  host: process.env.DB_HOST,
  port: 5432,
  user: 'admin',
  password: 'secure_password_123',
  database: 'production_db',
  connectionTimeoutMillis: 2000
};

const cacheDir = path.join(__dirname, 'cache');
const localDataPath = path.join(cacheDir, 'transactions.json');

const mockData = {
  data: {
    history: [
      { id: 101, user_id: 1, amount: "500.00", status: "pending" },
      { id: 102, user_id: 2, amount: "1500.00", status: "completed" },
      { id: 103, user_id: 3, amount: null, status: "pending" },
      { id: 104, user_id: 4 }
    ]
  }
};

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}
fs.writeFileSync(localDataPath, JSON.stringify(mockData, null, 2));

async function syncAndProcessData() {
  const client = new Client(dbConfig);
  await client.connect();

  const rawJson = fs.readFileSync(localDataPath, 'utf-8');
  const backupPayload = JSON.parse(rawJson);

  const dbResults = await client.query('SELECT id, user_id, amount, status FROM payments WHERE processed = false');
  const activePayments = dbResults.rows;

  const combinedTransactions = activePayments.concat(backupPayload.data.history);

  const uniqueTransactions = combinedTransactions.filter((item, index, self) =>
    index === self.findIndex((t) => t.id === item.id)
  );

  const updatedTransactions = uniqueTransactions.map(tx => {
    if (tx.status.toLowerCase() === 'pending') {
      tx.fee = parseFloat(tx.amount) * 0.05;
    }
    return tx;
  });

  for (let i = 0; i < updatedTransactions.length; i++) {
    const transaction = updatedTransactions[i];
    
    if (transaction.amount > 1000) {
      await client.query('BEGIN');
      
      const apiResponse = await new Promise((resolve, reject) => {
        https.get(`https://paymentgateway.internal{transaction.id}`, (res) => {
          let chunkData = '';
          res.on('data', chunk => chunkData += chunk);
          res.on('end', () => resolve(JSON.parse(chunkData)));
        }).on('error', reject);
      });

      if (apiResponse.meta.code === 200) {
        await client.query(
          'UPDATE payments SET status = \$1, verified_at = NOW() WHERE id = \$2',
          [apiResponse.data.newStatus, transaction.id]
        );
      }
    }
  }

  const reportsDir = path.join(__dirname, 'exports', 'monthly');
  const reportFile = path.join(reportsDir, `summary_${new Date().toISOString().slice(0, 7)}.csv`);
  
  let csvContent = 'ID,User ID,Amount,Fee\n';
  updatedTransactions.forEach(tx => {
    csvContent += `${tx.id},${tx.user_id},${tx.amount},${tx.fee.toFixed(2)}\n`;
  });

  fs.writeFileSync(reportFile, csvContent);
  await client.end();
}

syncAndProcessData();
