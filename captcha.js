import { randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const glyphs = {
  2:['01110','10001','00001','00010','00100','01000','11111'],3:['11110','00001','00001','01110','00001','00001','11110'],
  4:['00010','00110','01010','10010','11111','00010','00010'],5:['11111','10000','10000','11110','00001','00001','11110'],
  6:['01110','10000','10000','11110','10001','10001','01110'],7:['11111','00001','00010','00100','01000','01000','01000'],
  8:['01110','10001','10001','01110','10001','10001','01110'],9:['01110','10001','10001','01111','00001','00001','01110']
};
function crc32(data) { let crc = -1; for (const b of data) { crc ^= b; for (let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^-1)>>>0; }
function chunk(name, data) { const type=Buffer.from(name), size=Buffer.alloc(4), crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]); }
export function makeCaptcha() {
  const code = Array.from({length:6},()=>String(randomInt(2,10))).join('');
  const width=240,height=80,pixels=Buffer.alloc(height*(width*3+1),245);
  for(let y=0;y<height;y++) pixels[y*(width*3+1)]=0;
  function point(x,y,color) { x=Math.round(x);y=Math.round(y);if(x<0||y<0||x>=width||y>=height)return; const pos=y*(width*3+1)+1+x*3; pixels[pos]=color[0];pixels[pos+1]=color[1];pixels[pos+2]=color[2]; }
  for(let i=0;i<1400;i++) point(randomInt(width),randomInt(height),[randomInt(150,230),randomInt(150,230),randomInt(150,230)]);
  [...code].forEach((digit,i)=>{
    const x0=10+i*38,y0=randomInt(15,28),skew=(randomInt(0,9)-4)/12;
    glyphs[digit].forEach((row,y)=>[...row].forEach((on,x)=>{if(on==='1')for(let dy=0;dy<6;dy++)for(let dx=0;dx<5;dx++)point(x0+x*5+dx+skew*(y*6+dy),y0+y*6+dy,[45,80,62]);}));
  });
  for(let n=0;n<3;n++) {const offset=randomInt(5,65);for(let x=0;x<width;x++) point(x,offset+Math.sin(x/25+n)*5,[132,155,120]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  return {code,image:`data:image/png;base64,${png.toString('base64')}`};
}
