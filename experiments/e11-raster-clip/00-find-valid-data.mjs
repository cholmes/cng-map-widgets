// E11 step 0 -- is there actually data where we are clipping?
// The first Sentinel-2 item Earth Search returned for the demo bbox was a
// partial swath: only 22% of the granule carried pixels, and the first
// windowed read came back all zeros. A granule's STAC footprint is not its
// valid-data extent. This prints an ASCII coverage map from the coarsest
// overview (4 requests) so a scene can be sanity-checked in a second.
import { fromUrl } from 'geotiff';
const url='https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/EG/2025/9/S2B_10SEG_20250923_0_L2A/B04.tif';
const t=await fromUrl(url); const img=await t.getImage(4); // 687x687, 160m
const a=await img.readRasters({samples:[0]}); const v=a[0]; const w=a.width,h=a.height;
let nz=0; for(const x of v) if(x!==0) nz++;
console.log('level4',w,h,'nonzero',nz,(100*nz/v.length).toFixed(1)+'%');
// coarse map
let out='';
for(let r=0;r<h;r+=Math.floor(h/24)){let line='';for(let c=0;c<w;c+=Math.floor(w/48)){line+= v[r*w+c]===0?'.':'#';}out+=line+'\n';}
console.log(out);
// find a dense 64x64 (level4 px = 10.2km) block center
let best=null;
for(let r=0;r<h-32;r+=16)for(let c=0;c<w-32;c+=16){let cnt=0;for(let i=0;i<32;i+=2)for(let j=0;j<32;j+=2)if(v[(r+i)*w+c+j]!==0)cnt++;if(!best||cnt>best.cnt)best={r,c,cnt};}
console.log('best block level4 row/col',best);
const base=await t.getImage(0);const [ox,oy]=base.getOrigin();
const scale=10980/w;
const cx=(best.c+16)*scale, cy=(best.r+16)*scale; // base px
console.log('base px center',Math.round(cx),Math.round(cy),'UTM',ox+cx*10, oy-cy*10);
