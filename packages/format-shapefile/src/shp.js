// @cnmw/format-shapefile -- .shp/.shx binary writer (ESRI Shapefile Technical
// Description, 1998). Zero dependencies. Mixed-endianness is the classic
// gotcha this file gets right deliberately: file-header lengths and every
// per-record header are BIG-endian int32; everything else (version, shape
// type, bounding boxes, part indices, point coordinates) is LITTLE-endian.

export const SHAPE_TYPE = { Point: 1, PolyLine: 3, Polygon: 5, MultiPoint: 8 };

/** Shapefile has exactly one shape type per file; these are the only
 *  GeoJSON-type groupings that can coexist in one (Polygon absorbs
 *  MultiPolygon via multi-part rings; PolyLine absorbs MultiLineString the
 *  same way; Point and MultiPoint are genuinely distinct shape types and
 *  cannot mix). @param {string} geojsonType */
export function shapeFamilyOf(geojsonType) {
  if (geojsonType === 'Polygon' || geojsonType === 'MultiPolygon') return 'Polygon';
  if (geojsonType === 'LineString' || geojsonType === 'MultiLineString') return 'PolyLine';
  if (geojsonType === 'Point') return 'Point';
  if (geojsonType === 'MultiPoint') return 'MultiPoint';
  throw new Error(`@cnmw/format-shapefile: unsupported geometry type "${geojsonType}"`);
}

/** Shoelace signed area; positive = counter-clockwise in standard (y-up) orientation. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/**
 * Flatten a GeoJSON Polygon/MultiPolygon's rings into Shapefile's required
 * winding convention: outer rings clockwise, holes counter-clockwise --
 * the mirror image of GeoJSON's own (RFC 7946: outer CCW, holes CW).
 * Orientation is corrected by signed area, not assumed from input order,
 * so malformed input doesn't silently mis-encode holes as outer rings.
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @returns {number[][][]} an array of rings (each ring: array of [x,y])
 */
export function polygonRingsForShapefile(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const out = [];
  for (const rings of polygons) {
    rings.forEach((ring, i) => {
      const area = signedArea(ring);
      const isOuter = i === 0;
      const needsCW = isOuter; // outer: want CW (negative area); hole: want CCW (positive area)
      const isCCW = area > 0;
      const wantsReversal = needsCW ? isCCW : !isCCW;
      out.push(wantsReversal ? [...ring].reverse() : ring);
    });
  }
  return out;
}

/** @param {GeoJSON.LineString|GeoJSON.MultiLineString} geometry @returns {number[][][]} */
export function linePartsFor(geometry) {
  return geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
}

/** [xmin,ymin,xmax,ymax] over an array of [x,y] points. */
function bboxOfPoints(points) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of points) {
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  return [xmin, ymin, xmax, ymax];
}

/**
 * Build one shape record's content bytes (everything after the 8-byte
 * record header), for Polygon/PolyLine (parts of points) or Point/MultiPoint.
 * @param {number} shapeType
 * @param {number[][][]|null} parts - null for a null-shape record
 * @returns {Uint8Array}
 */
function buildPartsRecord(shapeType, parts) {
  if (!parts || parts.length === 0) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, 0, true); // shape type 0 = null shape
    return buf;
  }
  const allPoints = parts.flat();
  const [xmin, ymin, xmax, ymax] = bboxOfPoints(allPoints);
  const numParts = parts.length;
  const numPoints = allPoints.length;
  const byteLength = 4 + 32 + 4 + 4 + numParts * 4 + numPoints * 16;
  const buf = new Uint8Array(byteLength);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setInt32(o, shapeType, true); o += 4;
  view.setFloat64(o, xmin, true); o += 8;
  view.setFloat64(o, ymin, true); o += 8;
  view.setFloat64(o, xmax, true); o += 8;
  view.setFloat64(o, ymax, true); o += 8;
  view.setInt32(o, numParts, true); o += 4;
  view.setInt32(o, numPoints, true); o += 4;
  let pointIndex = 0;
  for (const part of parts) {
    view.setInt32(o, pointIndex, true); o += 4;
    pointIndex += part.length;
  }
  for (const part of parts) {
    for (const [x, y] of part) {
      view.setFloat64(o, x, true); o += 8;
      view.setFloat64(o, y, true); o += 8;
    }
  }
  return buf;
}

function buildPointRecord(xy) {
  if (!xy) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, 0, true);
    return buf;
  }
  const buf = new Uint8Array(4 + 16);
  const view = new DataView(buf.buffer);
  view.setInt32(0, SHAPE_TYPE.Point, true);
  view.setFloat64(4, xy[0], true);
  view.setFloat64(12, xy[1], true);
  return buf;
}

function buildMultiPointRecord(points) {
  if (!points || points.length === 0) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, 0, true);
    return buf;
  }
  const [xmin, ymin, xmax, ymax] = bboxOfPoints(points);
  const buf = new Uint8Array(4 + 32 + 4 + points.length * 16);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setInt32(o, SHAPE_TYPE.MultiPoint, true); o += 4;
  view.setFloat64(o, xmin, true); o += 8;
  view.setFloat64(o, ymin, true); o += 8;
  view.setFloat64(o, xmax, true); o += 8;
  view.setFloat64(o, ymax, true); o += 8;
  view.setInt32(o, points.length, true); o += 4;
  for (const [x, y] of points) {
    view.setFloat64(o, x, true); o += 8;
    view.setFloat64(o, y, true); o += 8;
  }
  return buf;
}

/**
 * @param {number} shapeType one of SHAPE_TYPE
 * @param {GeoJSON.Geometry|null} geometry - already the single family this
 *   shapeType was fixed to (callers ensure that upstream).
 * @returns {Uint8Array}
 */
export function buildShapeRecordContent(shapeType, geometry) {
  if (!geometry) {
    if (shapeType === SHAPE_TYPE.Point) return buildPointRecord(null);
    if (shapeType === SHAPE_TYPE.MultiPoint) return buildMultiPointRecord(null);
    return buildPartsRecord(shapeType, null);
  }
  if (shapeType === SHAPE_TYPE.Point) return buildPointRecord(geometry.coordinates);
  if (shapeType === SHAPE_TYPE.MultiPoint) return buildMultiPointRecord(geometry.coordinates);
  if (shapeType === SHAPE_TYPE.Polygon) return buildPartsRecord(shapeType, polygonRingsForShapefile(geometry));
  if (shapeType === SHAPE_TYPE.PolyLine) return buildPartsRecord(shapeType, linePartsFor(geometry));
  throw new Error(`@cnmw/format-shapefile: unsupported shape type ${shapeType}`);
}

/**
 * @param {number} shapeType
 * @param {Uint8Array[]} recordContents - one per feature, in order (from `buildShapeRecordContent`)
 * @param {[number, number, number, number]} overallBbox
 * @returns {{ shp: Uint8Array, shx: Uint8Array }}
 */
export function assembleShpShx(shapeType, recordContents, overallBbox) {
  const [xmin, ymin, xmax, ymax] = overallBbox ?? [0, 0, 0, 0];
  const shpBodyLength = recordContents.reduce((sum, c) => sum + 8 + c.length, 0);
  const shp = new Uint8Array(100 + shpBodyLength);
  const shx = new Uint8Array(100 + recordContents.length * 8);

  writeHeader(shp, shapeType, 100 + shpBodyLength, [xmin, ymin, xmax, ymax]);
  writeHeader(shx, shapeType, 100 + recordContents.length * 8, [xmin, ymin, xmax, ymax]);

  const shpView = new DataView(shp.buffer);
  const shxView = new DataView(shx.buffer);
  let shpOffset = 100;
  let shxOffset = 100;
  recordContents.forEach((content, i) => {
    const contentWords = content.length / 2;
    shpView.setInt32(shpOffset, i + 1, false); // record number, 1-based, big-endian
    shpView.setInt32(shpOffset + 4, contentWords, false); // content length in words, big-endian
    shp.set(content, shpOffset + 8);

    shxView.setInt32(shxOffset, shpOffset / 2, false); // offset in words, big-endian
    shxView.setInt32(shxOffset + 4, contentWords, false);

    shpOffset += 8 + content.length;
    shxOffset += 8;
  });

  return { shp, shx };
}

function writeHeader(buf, shapeType, fileLengthBytes, [xmin, ymin, xmax, ymax]) {
  const view = new DataView(buf.buffer);
  view.setInt32(0, 9994, false); // file code, big-endian
  view.setInt32(24, fileLengthBytes / 2, false); // file length in 16-bit words, big-endian
  view.setInt32(28, 1000, true); // version
  view.setInt32(32, shapeType, true);
  view.setFloat64(36, Number.isFinite(xmin) ? xmin : 0, true);
  view.setFloat64(44, Number.isFinite(ymin) ? ymin : 0, true);
  view.setFloat64(52, Number.isFinite(xmax) ? xmax : 0, true);
  view.setFloat64(60, Number.isFinite(ymax) ? ymax : 0, true);
  // bytes 68-99 (Z/M range): left zero, unused for 2D
}
