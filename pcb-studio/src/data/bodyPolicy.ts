// Shared by browser and server: existing model families always win over AI geometry.
import { findConcept } from './concepts.ts'

export const WEARABLE = /(wrist|bracelet|wearable|smartwatch|\bwatch\b|armband|forearm|glove|sleeve|\bstrap\b|\bband\b)/i
// Whole words keep "card" and "cardiac" from matching cars.
export const VEHICLE = /\b(rovers?|robots?|cars?|wheel(s|ed)?|4wd|2wd|chassis|tanks?|buggy|drive(s|train)?|line[- ]follow(er|ing)?)\b/i
export const FLYER = /\b(drone|quad(copter)?|fpv|multirotor|uav|hexa(copter)?|octo(copter)?|copter)\b/i
export const EYEWEAR = /\b(glasses|goggles|spectacles|eyewear|sunglasses|visor|hud)\b/i
export const BREWER = /\b(coffee|espresso|brew(er|ing)?)\b/i
export const LAMP = /\b(lamp|desk light|task light)\b/i
export const PRINTER = /\b(3d ?print(er|ing)?|printer)\b/i

export function hasBuiltInBody(text: string): boolean {
  return Boolean(findConcept(text)) || [FLYER, EYEWEAR, WEARABLE, VEHICLE, BREWER, PRINTER, LAMP].some((re) => re.test(text))
}
