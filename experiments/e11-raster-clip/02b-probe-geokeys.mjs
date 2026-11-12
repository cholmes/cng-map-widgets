// E11 step 2b -- which geokey sets survive geotiff.js's writer?
// Answer (see RESULTS.md 3): only {GTModelType, GTRasterType,
// ProjectedCSType}. Adding GTCitationGeoKey (ASCII) or ProjLinearUnitsGeoKey
// yields TIFFTagLocation=0/count=0 and GDAL drops ALL georeferencing.
import { writeArrayBuffer } from 'geotiff';
import { writeFileSync } from 'node:fs';
const OUT=process.argv[2];
const W=4,H=4;
const variants = {
  'minimal-geokeys': { GTModelTypeGeoKey:1, GTRasterTypeGeoKey:1, ProjectedCSTypeGeoKey:32610 },
  'with-citation':   { GTModelTypeGeoKey:1, GTRasterTypeGeoKey:1, ProjectedCSTypeGeoKey:32610, GTCitationGeoKey:'WGS 84 / UTM zone 10N' },
};
for (const [name, gk] of Object.entries(variants)) {
  const md = { ...gk, width:W, height:H, ModelPixelScale:[10,10,0], ModelTiepoint:[0,0,0,561580,4189480,0], BitsPerSample:[8], SampleFormat:[1], SamplesPerPixel:[1], PhotometricInterpretation:1 };
  const buf = writeArrayBuffer(Uint8Array.from({length:W*H},(_,i)=>i*16), md);
  writeFileSync(`${OUT}/geokeys-${name}.tif`, Buffer.from(buf));
  console.log(name, buf.byteLength);
}
