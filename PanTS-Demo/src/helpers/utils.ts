import type { Color } from "@cornerstonejs/core/types";
import JSZip from "jszip";
export const cleanName = (case_id: string) => {
    let new_id = case_id;
    new_id = new_id.replace("PanTS_", "");
    while (new_id[0] === "0") {
        new_id = new_id.substring(1);
    }
    return new_id
}

function colorDistance(c1: number[], c2: number[]) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const d = c1[i] - c2[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export type Vec3 = [number, number, number];
export function cornerstoneLpsMmToThree(
    lpsMm: Vec3,
    center: Vec3
): Vec3 {
    const [l, p, s] = lpsMm;

    // Cornerstone world is usually LPS:
    // L = left
    // P = posterior
    // S = superior
    //
    // NIfTI/nibabel world is usually RAS:
    // R = -L
    // A = -P
    // S = S
    const rasX = -l;
    const rasY = -p;
    const rasZ = s;

    // Must match your Python mesh export:
    // three = [rasX, rasZ, -rasY]
    const threeX = rasX;
    const threeY = rasZ;
    const threeZ = -rasY;

    return [
        threeX - center[0],
        threeY - center[1],
        threeZ - center[2],
    ];
}

export function closestColorIndex(
  target: number[],
  dict: { [key: number]: Color }
): number {
  let bestIndex = -1;
  let bestDist = Infinity;

  for (const key in dict) {
    const dist = colorDistance(target, dict[key]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = Number(key);
    }
  }

  return bestIndex;
}

export function filenameToName(filename: string): string {
    const index = filename.indexOf('.');
    if (index === -1) {
        return filename;
    }

    return filename.substring(0, index);
}

export function arrayIsEqual<T>(arr1: T[], arr2: T[]): boolean {
    if (arr1.length !== arr2.length) {
        return false;
    }
    for (let i = 0; i < arr1.length; i++){
        if (arr1[i] !== arr2[i]){
            return false;
        }
    }
    return true;
}

export const getPanTSId = (case_id: string) => {
    let new_id = case_id;
    const iter = 8 - new_id.toString().length;
    for (let i = 0; i < Math.max(0, iter); i++) {
        new_id = "0" + new_id;
    }
    return `PanTS_${new_id}`;
}

export function capitalize(word: string) {
	if (!word) return "";
	return word.charAt(0).toUpperCase() + word.slice(1);
}

export function roundDigits(x: number, digits: number) {
	return parseFloat(x.toFixed(digits));
}

export async function zipToURL(data: Blob) {

    const zip = await JSZip.loadAsync(data);
    const sliceImages = [];

    for (const fileName of Object.keys(zip.files)) {
        const fileData = await zip.files[fileName].async("blob");
        const url = URL.createObjectURL(fileData);
        sliceImages.push({ name: fileName, url });
    }

    // Sort slices by filename so they are in order
    sliceImages.sort((a, b) => a.name.localeCompare(b.name));
    const urlSlices = sliceImages.map((el) => el.url);
    return urlSlices
}

export function prettify_segmentation_category(txt: string) {
    const arr = txt.split("_").map((el) => capitalize(el));
    return arr.join(" ");
}

export function deepIsEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }

  const keysA = Object.keys(a) as (keyof T)[];
  const keysB = Object.keys(b) as (keyof T)[];

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepIsEqual(a[key], b[key])) return false;
  }

  return true;
}

