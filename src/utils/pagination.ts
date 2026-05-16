export const POSTS_PER_PAGE = 6;
export const HOME_POSTS_LIMIT = 3;

export function paginatePosts<T>(posts: T[], page: number, pageSize = POSTS_PER_PAGE) {
  const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;

  return {
    posts: posts.slice(start, end),
    currentPage,
    totalPages,
  };
}

export function formatPublishedDate(isoDate: string, locale = 'en-US') {
  if (!isoDate) return '';
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
