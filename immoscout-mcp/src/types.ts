export interface ImmoscoutSearchHit {
  exposeId: string;
  title: string;
  price: number | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  district: number | null;
  zip: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  badges: string[];
  isPrivate: boolean;
  isSocialHousing: boolean;
  url: string;
  imageUrl: string | null;
  dateCreated: string | null;
}

export interface ImmoscoutSearchResult {
  listings: ImmoscoutSearchHit[];
  totalHitsCitywide: number;
  pagesScanned: number;
  totalPagesAvailable: number;
  /** true when the scan stopped at maxPages while more result pages existed. */
  hitPageCap: boolean;
}
