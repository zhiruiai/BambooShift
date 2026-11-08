export interface AvatarSource {
  id: string;
  /** Original pixel dimensions after applying EXIF orientation. */
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  expiresAt: string;
}
export interface AvatarCrop {
  left: number;
  top: number;
  size: number;
}
export interface CropAvatarInput {
  sourceId: string;
  crop: AvatarCrop;
}
export interface AvatarAsset {
  id: string;
  width: 512;
  height: 512;
  mimeType: 'image/webp';
  createdAt: string;
}
/** Uploads must be strictly smaller than this limit. */
export const MAX_AVATAR_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_AVATAR_INPUT_PIXELS = 40_000_000;
export const AVATAR_UPLOAD_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
