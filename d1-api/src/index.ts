export interface Env {
  DB: D1Database;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function isValidPost(body: unknown): body is { title: string; content: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as any).title === "string" &&
    typeof (body as any).content === "string"
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/" && method === "GET") {
      return json({ status: "ok", service: "d1-api" });
    }

    const postsMatch = path.match(/^\/posts\/?$/);
    const postMatch = path.match(/^\/posts\/(\d+)\/?$/);

    try {
      if (postsMatch && method === "GET") {
        const results = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
        return json({ posts: results.results });
      }

      if (postsMatch && method === "POST") {
        const body = await request.json();
        if (!isValidPost(body)) {
          return json({ error: "title and content are required strings" }, 400);
        }
        const result = await env.DB.prepare(
          "INSERT INTO posts (title, content) VALUES (?, ?) RETURNING *"
        ).bind(body.title, body.content).first();
        return json({ post: result }, 201);
      }

      if (postMatch && method === "GET") {
        const id = postMatch[1];
        const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first();
        if (!post) return json({ error: "Post not found" }, 404);
        return json({ post });
      }

      if (postMatch && method === "PUT") {
        const id = postMatch[1];
        const body = await request.json();
        if (!isValidPost(body)) {
          return json({ error: "title and content are required strings" }, 400);
        }
        const result = await env.DB.prepare(
          "UPDATE posts SET title = ?, content = ? WHERE id = ? RETURNING *"
        ).bind(body.title, body.content, id).first();
        if (!result) return json({ error: "Post not found" }, 404);
        return json({ post: result });
      }

      if (postMatch && method === "DELETE") {
        const id = postMatch[1];
        const result = await env.DB.prepare(
          "DELETE FROM posts WHERE id = ? RETURNING id"
        ).bind(id).first();
        if (!result) return json({ error: "Post not found" }, 404);
        return json({ success: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Internal server error", detail: String(err) }, 500);
    }
  },
};
