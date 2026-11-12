// @cnmw/maplibre -- viewport provider (design doc §5.1 item 2, §5.2).

/**
 * @param {import('maplibre-gl').Map} map
 * @returns {() => [number, number, number, number]}
 */
export function viewportProvider(map) {
  return () => {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  };
}
