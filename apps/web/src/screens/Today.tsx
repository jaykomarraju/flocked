// Today moved to src/features/today (W9-C). routes.tsx is D-owned and still imports it from here, so
// this re-export stays until W9-D points the route at features/today/Today and deletes this file.
export { Today } from '../features/today/Today';
export { ROUNDS_TODAY_KEY, formatGameDay } from '../features/today/api';
