import { useEffect, useState } from 'react';
import { fetchChats, type ApiChats } from './api';

const EMPTY: ApiChats = { waiting: [], finished: [], working: [] };

/** The open chats, read every few seconds. The same list the menu bar shows. */
export function useChats(everyMs = 8000): ApiChats {
  const [chats, setChats] = useState<ApiChats>(EMPTY);
  useEffect(() => {
    let alive = true;
    const read = () => {
      fetchChats()
        .then(c => { if (alive) setChats(c); })
        .catch(() => { /* keep the last list: the dashboard may be restarting */ });
    };
    read();
    const t = window.setInterval(read, everyMs);
    return () => { alive = false; window.clearInterval(t); };
  }, [everyMs]);
  return chats;
}
