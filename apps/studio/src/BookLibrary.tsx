import { useEffect, useState } from 'react';
import { coRequest } from './CoWriting';
export default function BookLibrary() { const [title, setTitle] = useState(''), [books, setBooks] = useState<Array<{
    id: string;
    title: string;
}>>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false); useEffect(() => { void coRequest<{
    books: Array<{
        id: string;
        title: string;
    }>;
}>('/api/books').then(p => setBooks(p.books)).catch(e => setError(String(e))); }, []); const open = async (path: string, body: unknown) => { setBusy(true); try {
    const p = await coRequest<{
        url: string;
    }>(path, body);
    window.location.assign(p.url + '#book');
}
catch (e) {
    setError(String(e));
    setBusy(false);
} }; return <details className="book-library"><summary>切换 / 新建独立作品</summary><p className="muted">新书使用独立 Vault，当前作品保持原样。</p><input aria-label="新作品名称" placeholder="新作品名称" value={title} onChange={e => setTitle(e.target.value)}/><button disabled={busy || !title.trim()} onClick={() => void open('/api/books/create', { title, confirm: true })}>确认创建独立作品</button>{books.map(b => <button key={b.id} disabled={busy} onClick={() => void open('/api/books/open', { id: b.id })}>{b.title}</button>)}{error && <p role="alert">{error}</p>}</details>; }
