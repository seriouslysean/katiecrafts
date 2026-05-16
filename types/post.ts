export interface TaxonomyTerm {
  id: number;
  name: string;
  slug: string;
}

export interface FeaturedImageMeta {
  src: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface PostData {
  title: string;
  slug: string;
  date: string; // YYYYMMDD
  publishedDate: string; // YYYY-MM-DD
  excerpt?: string;
  content: string; // HTML
  featuredImage?: FeaturedImageMeta;
  categories: TaxonomyTerm[];
  tags: TaxonomyTerm[];
}

export interface WordPressPost {
  id: number;
  date: string;
  slug: string;
  title: {
    rendered: string;
  };
  content: {
    rendered: string;
  };
  excerpt: {
    rendered: string;
  };
  featured_media: number;
  categories: number[];
  tags: number[];
  _embedded?: {
    'wp:featuredmedia'?: Array<{
      source_url: string;
      media_details: {
        sizes: {
          full?: {
            source_url: string;
            width: number;
            height: number;
          };
          [key: string]: { source_url: string; width: number; height: number } | undefined;
        };
        width?: number;
        height?: number;
      };
      alt_text?: string;
    }>;
    'wp:term'?: Array<Array<{
      id: number;
      name: string;
      slug: string;
    }>>;
  };
}
