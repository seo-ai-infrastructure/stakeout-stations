export const surfaces = ['Chrome · Local pack', 'Chrome · Local Finder', 'Chrome · AI Overview', 'Chrome · AI Mode', 'Google Maps', 'Google app', 'Gemini', 'Waze'] as const;
export type Campaign = { id: string; business: string; listing: string; keywords: string[]; location: string; days: number; warmup: number; devices: number; concurrency: number; surfaces: string[]; createdAt: string; status: 'draft' };
export function validateCampaign(c: Omit<Campaign, 'id' | 'createdAt' | 'status'>): string[] {
  const errors: string[] = [];
  if (!c.business.trim() || !c.location.trim()) errors.push('Business and target location are required.');
  try { const url = new URL(c.listing); if (url.protocol !== 'https:') throw Error(); } catch { errors.push('Enter an HTTPS Google Business or Maps listing URL.'); }
  if (!c.keywords.length || c.keywords.length > 100 || c.keywords.some(k => !k.trim() || k.length > 200)) errors.push('Enter between 1 and 100 keywords, up to 200 characters each.');
  if (!Number.isInteger(c.days) || c.days < 11 || c.days > 45) errors.push('Campaign length must be 11–45 days.');
  if (!Number.isInteger(c.warmup) || c.warmup < 10 || c.warmup > 30 || c.warmup >= c.days) errors.push('Warmup must be 10–30 days and leave at least one tracking day.');
  if (!Number.isInteger(c.devices) || c.devices < 1 || c.devices > 100) errors.push('Choose 1–100 devices.');
  if (!Number.isInteger(c.concurrency) || c.concurrency < 1 || c.concurrency > c.devices) errors.push('Concurrency must be between 1 and the device count.');
  if (!c.surfaces.length || c.surfaces.some(s => !(surfaces as readonly string[]).includes(s))) errors.push('Select at least one supported surface.');
  return errors;
}
export function readDrafts(raw: string | null): Campaign[] {
  if (!raw) return [];
  try { const data: unknown = JSON.parse(raw); if (!Array.isArray(data)) return [];
    return data.filter((c): c is Campaign => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.business === 'string' && typeof c.location === 'string' && typeof c.listing === 'string' && typeof c.createdAt === 'string' && Array.isArray(c.keywords) && c.keywords.every((k: unknown) => typeof k === 'string') && Array.isArray(c.surfaces) && c.status === 'draft' && validateCampaign(c).length === 0);
  } catch { return []; }
}
export const demoPoints = [
  { id: 'MB-01', lat: 25.786, lng: -80.141, rank: 3, competitor: 'Example Coastal Law', competitorRank: 1 },
  { id: 'MB-02', lat: 25.786, lng: -80.133, rank: 1, competitor: 'Example Coastal Law', competitorRank: 2 },
  { id: 'MB-03', lat: 25.786, lng: -80.125, rank: 7, competitor: 'Example Beach Legal', competitorRank: 1 },
  { id: 'MB-04', lat: 25.777, lng: -80.141, rank: 2, competitor: 'Example Coastal Law', competitorRank: 1 },
  { id: 'MB-05', lat: 25.777, lng: -80.133, rank: 5, competitor: 'Example Beach Legal', competitorRank: 2 },
  { id: 'MB-06', lat: 25.777, lng: -80.125, rank: 4, competitor: 'Example Coastal Law', competitorRank: 1 },
  { id: 'MB-07', lat: 25.768, lng: -80.141, rank: null, competitor: null, competitorRank: null },
  { id: 'MB-08', lat: 25.768, lng: -80.133, rank: 1, competitor: 'Example Beach Legal', competitorRank: 3 },
  { id: 'MB-09', lat: 25.768, lng: -80.125, rank: 3, competitor: 'Example Coastal Law', competitorRank: 2 },
];
export type Point = typeof demoPoints[number];
