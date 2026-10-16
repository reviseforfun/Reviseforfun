# D1 API — Cloudflare Workers + D1 Backend

A REST API backed by Cloudflare D1 (SQLite at the edge). Full CRUD for a `posts` resource.

## Quick Start

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

## API Endpoints

| Method   | Path         | Description    |
|----------|-------------|----------------|
| GET      | /            | Health check   |
| GET      | /posts      | List all posts |
| POST     | /posts      | Create a post  |
| GET      | /posts/:id  | Get a post     |
| PUT      | /posts/:id  | Update a post  |
| DELETE   | /posts/:id  | Delete a post  |

## Example

```bash
curl -X POST http://localhost:8787/posts -H "Content-Type: application/json" -d '{"title":"My Post","content":"Hello!"}'
curl http://localhost:8787/posts
```
