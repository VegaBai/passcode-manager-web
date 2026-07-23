const http = require('http');
const fs = require('fs');
const path = require('path');
const apiHandler = require('./api/app');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(root, relative);

  if (!filePath.startsWith(root)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(root, 'index.html'), (fallbackError, fallback) => {
        if (fallbackError) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        res.setHeader('Content-Type', mime['.html']);
        res.end(fallback);
      });
      return;
    }

    res.setHeader('Content-Type', mime[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  req.localPreview = true;
  if (req.url.startsWith('/api')) {
    apiHandler(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`Passcode Manager Web running at http://localhost:${port}`);
});
