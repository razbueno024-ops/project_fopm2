const { app } = require('./server');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FOPM prototype running at http://localhost:${PORT}`);
  console.log('Admin credentials are configured in data/db.json or through Admin Settings.');
});
