import { useEffect, useState } from 'react';
import { configApi, type LocalMemory as MemoryReading } from '../lib/configApi';

const gib = 1024 ** 3;
const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function LocalMemory({ compact = false }: { compact?: boolean }) {
  const [memory, setMemory] = useState<MemoryReading | null>(null);

  useEffect(() => {
    const request = new AbortController();
    let timer: number;
    const refresh = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const result = await configApi.localMemory(request.signal);
          if (!request.signal.aborted) setMemory(result.memory);
          if (result.memory === null) return;
        } catch {
          if (!request.signal.aborted) setMemory(null);
        }
      }
      if (!request.signal.aborted) timer = window.setTimeout(refresh, 15000);
    };
    void refresh();
    return () => { request.abort(); clearTimeout(timer); };
  }, []);

  if (!memory) return null;
  const available = format.format(memory.available / gib);
  const total = format.format(memory.total / gib);
  const label = `${available} GiB of ${total} GiB host RAM available`;
  return compact
    ? <span className="chat-model__memory" title={label}>{available} GiB RAM available</span>
    : <p className="cfg-field__hint">{label}</p>;
}
