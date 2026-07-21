const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'content-security-policy',
  'x-frame-options',
]);

function toProxyUrl(targetUrl) {
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function resolveAndRewrite(rawUrl, baseUrl) {
  if (!rawUrl) return rawUrl;
  if (/^(data|javascript|mailto|tel|#):/i.test(rawUrl)) return rawUrl;
  try {
    const absolute = new URL(rawUrl, baseUrl).toString();
    return toProxyUrl(absolute);
  } catch {
    return rawUrl;
  }
}

function rewriteHtml(html, baseUrl) {
  html = html.replace(
    /(\s(?:href|src|action|poster)\s*=\s*)(["'])(.*?)\2/gi,
    (match, prefix, quote, value) => `${prefix}${quote}${resolveAndRewrite(value, baseUrl)}${quote}`
  );

  html = html.replace(
    /(\ssrcset\s*=\s*)(["'])(.*?)\2/gi,
    (match, prefix, quote, value) => {
      const rewritten = value
        .split(',')
        .map((part) => {
          const trimmed = part.trim();
          const [url, descriptor] = trimmed.split(/\s+/, 2);
          const newUrl = resolveAndRewrite(url, baseUrl);
          return descriptor ? `${newUrl} ${descriptor}` : newUrl;
        })
        .join(', ');
      return `${prefix}${quote}${rewritten}${quote}`;
    }
  );

  html = html.replace(/<head(\s[^>]*)?>/i, (match) => {
    return `${match}<base href="${baseUrl}">`;
  });

  return html;
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\((['"]?)(.*?)\1\)/gi, (match, quote, value) => {
    if (/^data:/i.test(value)) return match;
    const rewritten = resolveAndRewrite(value, baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  });
}

app.use(express.static('public'));

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Missing "url" query parameter.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).send('Only http and https URLs are supported.');
  }

  try {
    const upstream = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent':
          req.get('user-agent') ||
          'Mozilla/5.0 (compatible; WebProxy/1.0)',
        Accept: req.get('accept') || '*/*',
      },
      redirect: 'follow',
    });

    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.status(upstream.status);

    const contentType = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || parsedUrl.toString();

    if (contentType.includes('text/html')) {
      const body = await upstream.text();
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(rewriteHtml(body, finalUrl));
    } else if (contentType.includes('text/css')) {
      const body = await upstream.text();
      res.set('Content-Type', 'text/css; charset=utf-8');
      res.send(rewriteCss(body, finalUrl));
    } else {
      upstream.body.pipe(res);
    }
  } catch (err) {
    res.status(502).send(`Failed to fetch target URL: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`WebProxy server listening on http://localhost:${PORT}`);
});
