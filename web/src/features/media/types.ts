import type { MediaKind } from "./constants";

/** An uploaded image as the owner's library shows it (client-safe). */
export interface MediaAssetView {
  id: string;
  kind: MediaKind;
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
  originalName: string | null;
  createdAt: string;
  /** The owner's profiles whose draft or published document references this image. */
  usedBy: { profileId: string; handle: string; draft: boolean; published: boolean }[];
}

export interface MediaUsage {
  usedBytes: number;
  quotaBytes: number;
}

export interface MediaLibrary extends MediaUsage {
  assets: MediaAssetView[];
}
