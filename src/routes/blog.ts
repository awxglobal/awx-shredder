/**
 * Blog routes — served publicly + internal write endpoint for the marketing agent.
 *
 * GET  /blog          → list of posts (HTML)
 * GET  /blog/:slug    → single post (HTML)
 * POST /api/blog      → create post (requires Authorization: Bearer INTERNAL_API_KEY)
 */

import { Hono } from 'hono';
import { db } from '../db/client.js';
import { blogPosts } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';

export const blogRouter = new Hono();

// ─── Internal: create post ────────────────────────────────────────────────────

blogRouter.post('/api/blog', async (c) => {
  const internalKey = process.env.INTERNAL_API_KEY;
  const auth = c.req.header('Authorization');

  if (!internalKey || auth !== `Bearer ${internalKey}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json<{
    slug: string;
    title: string;
    content: string;
    summary: string;
    tags?: string[];
    devtoUrl?: string;
    hashnodeUrl?: string;
  }>();

  if (!body.slug || !body.title || !body.content || !body.summary) {
    return c.json({ error: 'Missing required fields: slug, title, content, summary' }, 400);
  }

  try {
    await db.insert(blogPosts).values({
      slug: body.slug,
      title: body.title,
      content: body.content,
      summary: body.summary,
      tags: body.tags ?? [],
      devtoUrl: body.devtoUrl,
      hashnodeUrl: body.hashnodeUrl,
    });

    return c.json({ ok: true, slug: body.slug });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Duplicate slug — already published
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return c.json({ ok: true, slug: body.slug, note: 'already exists' });
    }
    return c.json({ error: msg }, 500);
  }
});

// ─── Public: list posts ───────────────────────────────────────────────────────

blogRouter.get('/blog', async (c) => {
  const posts = await db
    .select({
      slug: blogPosts.slug,
      title: blogPosts.title,
      summary: blogPosts.summary,
      tags: blogPosts.tags,
      publishedAt: blogPosts.publishedAt,
    })
    .from(blogPosts)
    .orderBy(desc(blogPosts.publishedAt))
    .limit(50);

  return c.html(renderBlogList(posts));
});

// ─── Public: single post ──────────────────────────────────────────────────────

blogRouter.get('/blog/:slug', async (c) => {
  const slug = c.req.param('slug');
  const [post] = await db.select().from(blogPosts).where(eq(blogPosts.slug, slug)).limit(1);

  if (!post) return c.html(render404(), 404);

  return c.html(renderBlogPost(post));
});

// ─── HTML renderers ───────────────────────────────────────────────────────────

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(title)} — AWX Shredder</title>
  <meta name="description" content="AWX Shredder blog — technical articles on AI agent cost control"/>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <style>* { font-family: 'Inter', sans-serif; } pre { overflow-x: auto; } code { font-family: monospace; }</style>
</head>
<body class="bg-[#060d18] text-slate-100 min-h-screen">
  <header class="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
    <a href="/" class="flex items-center gap-2 text-emerald-400 font-bold text-lg">AWX Shredder</a>
    <a href="/blog" class="text-slate-400 hover:text-slateald-100 text-sm">Blog</a>
  </header>
  <main class="max-w-3xl mx-auto px-6 py-12">
    ${body}
  </main>
  <footer class="border-t border-slate-800 px-6 py-6 text-center text-slate-500 text-sm">
    AWX Shredder · <a href="https://awx-shredder.fly.dev" class="hover:text-slate-300">awx-shredder.fly.dev</a>
  </footer>
</body>
</html>`;
}

function renderBlogList(
  posts: Array<{ slug: string; title: string; summary: string; tags: string[]; publishedAt: Date }>
): string {
  const items = posts
    .map(
      (p) => `
    <article class="border border-slate-800 rounded-xl p-6 hover:border-slate-600 transition-colors">
      <time class="text-slate-500 text-xs">${formatDate(p.publishedAt)}</time>
      <h2 class="text-lg font-semibold mt-1 mb-2">
        <a href="/blog/${escHtml(p.slug)}" class="hover:text-emerald-400 transition-colors">${escHtml(p.title)}</a>
      </h2>
      <p class="text-slate-400 text-sm leading-relaxed">${escHtml(p.summary)}</p>
      <div class="flex gap-2 mt-3 flex-wrap">
        ${p.tags.map((t) => `<span class="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-xs">${escHtml(t)}</span>`).join('')}
      </div>
    </article>`
    )
    .join('\n');

  const body = `
    <h1 class="text-3xl font-bold mb-2">Blog</h1>
    <p class="text-slate-400 mb-8">Technical articles on AI agent cost control</p>
    <div class="flex flex-col gap-4">
      ${items || '<p class="text-slate-500">No posts yet — check back soon.</p>'}
    </div>`;

  return shell('Blog', body);
}

function renderBlogPost(post: {
  title: string;
  content: string;
  summary: string;
  tags: string[];
  publishedAt: Date;
  devtoUrl: string | null;
  hashnodeUrl: string | null;
}): string {
  const crossLinks = [
    post.devtoUrl ? `<a href="${escHtml(post.devtoUrl)}" target="_blank" rel="noopener" class="text-emerald-400 hover:underline text-sm">dev.to</a>` : '',
    post.hashnodeUrl ? `<a href="${escHtml(post.hashnodeUrl)}" target="_blank" rel="noopener" class="text-emerald-400 hover:underline text-sm">Hashnode</a>` : '',
  ].filter(Boolean).join(' · ');

  // Simple markdown to HTML: code blocks, inline code, headings, bold, paragraphs
  const html = markdownToHtml(post.content);

  const body = `
    <div class="mb-2">
      <a href="/blog" class="text-slate-500 hover:text-slate-300 text-sm">← All articles</a>
    </div>
    <time class="text-slate-500 text-sm">${formatDate(post.publishedAt)}</time>
    <h1 class="text-3xl font-bold mt-2 mb-4 leading-tight">${escHtml(post.title)}</h1>
    <p class="text-slate-400 text-lg leading-relaxed mb-6">${escHtml(post.summary)}</p>
    ${crossLinks ? `<p class="text-slate-500 text-sm mb-8">Also on: ${crossLinks}</p>` : ''}
    <div class="prose-content text-slate-300 leading-relaxed">
      ${html}
    </div>
    <div class="mt-12 p-6 bg-[#0a1f14] border border-emerald-900 rounded-xl">
      <p class="text-emerald-400 font-semibold mb-2">Protect your agents with AWX Shredder</p>
      <p class="text-slate-400 text-sm mb-4">Hard budget limits for LLM API calls. One env var change. Free.</p>
      <a href="/" class="bg-emerald-500 hover:bg-emerald-400 text-white px-5 py-2 rounded-lg text-sm font-semibold inline-block transition-colors">Get started →</a>
    </div>`;

  return shell(post.title, body);
}

function render404(): string {
  return shell('Not found', '<h1 class="text-2xl font-bold">Post not found</h1><p class="text-slate-400 mt-2"><a href="/blog" class="text-emerald-400 hover:underline">← Back to blog</a></p>');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d: Date): string {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function markdownToHtml(md: string): string {
  return md
    // Fenced code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre class="bg-[#0a1628] border border-slate-700 rounded-lg p-4 my-4 text-sm text-emerald-300 overflow-x-auto"><code>${escHtml(code.trim())}</code></pre>`
    )
    // Inline code
    .replace(/`([^`]+)`/g, (_, code) =>
      `<code class="bg-[#0a1628] text-emerald-300 px-1.5 py-0.5 rounded text-sm">${escHtml(code)}</code>`
    )
    // H1
    .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-8 mb-3 text-slate-100">$1</h1>')
    // H2
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-semibold mt-6 mb-2 text-slate-100">$1</h2>')
    // H3
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-4 mb-2 text-slate-200">$1</h3>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>')
    // Blank lines → paragraph breaks
    .replace(/\n\n/g, '</p><p class="mb-4">')
    // Wrap in opening p
    .replace(/^/, '<p class="mb-4">')
    .replace(/$/, '</p>');
}
