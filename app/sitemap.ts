import type { MetadataRoute } from 'next';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://ai.modaafa.com').replace(/\/$/, '');

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    { url: `${APP_URL}/`, lastModified, changeFrequency: 'weekly', priority: 1 },
    { url: `${APP_URL}/login`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${APP_URL}/privacy`, lastModified, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${APP_URL}/terms`, lastModified, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${APP_URL}/data-deletion`, lastModified, changeFrequency: 'monthly', priority: 0.3 },
  ];
}
