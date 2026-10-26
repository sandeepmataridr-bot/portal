import { describe, expect, it } from 'vitest';
import { realtimeTarget } from './realtime';

describe('realtimeTarget', () => {
  it('connects straight to a local API', () => {
    expect(realtimeTarget('http://localhost:3000', 'http://localhost:5173')).toEqual({
      uri: 'http://localhost:3000/realtime',
      path: '/socket.io',
    });
  });

  it('puts an API mounted under /api into the socket path, not the namespace', () => {
    expect(realtimeTarget('/api', 'https://app.0dh.in')).toEqual({
      uri: 'https://app.0dh.in/realtime',
      path: '/api/socket.io',
    });
  });

  it('ignores a trailing slash', () => {
    expect(realtimeTarget('https://app.0dh.in/api/', 'https://app.0dh.in').path).toBe('/api/socket.io');
  });
});
