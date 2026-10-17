export const VERTEX = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'

// Pass 1: raymarch the scene into a low-res grayscale texture. During a morph it
// evaluates both shapes and blends their distance fields.
export const SCENE = /* glsl */ `
precision highp float;
uniform vec2 uRes;uniform float uTime;uniform vec2 uMouse;uniform vec2 uRot;
uniform int uA;uniform int uB;uniform float uK;uniform float uDist;uniform vec2 uOff;

mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float sdBox(vec3 p,vec3 b){vec3 q=abs(p)-b;return length(max(q,0.))+min(max(q.x,max(q.y,q.z)),0.);}

float knot(vec3 p){vec2 q=vec2(length(p.xz)-1.,p.y);q=rot(atan(p.z,p.x)*1.5)*q;
  return min(length(q-vec2(.36,0.)),length(q+vec2(.36,0.)))*.75-.12;}
float blobs(vec3 p){float d=length(p)-.5;
  for(int i=0;i<5;i++){float f=float(i);vec3 c=vec3(sin(uTime*.7+f*1.7),cos(uTime*.9+f*2.3),sin(uTime*.5+f*.9))*.78;d=smin(d,length(p-c)-.3,.45);}return d;}
float lattice(vec3 p){vec3 q=p*5.5+vec3(0.,uTime*.6,0.);float g=abs(dot(sin(q),cos(q.zxy)))/5.5-.03;return max(length(p)-1.05,g*.7);}
float orbit(vec3 p){float pl=length(p)-.6;vec3 r=p;r.xy=rot(.38)*r.xy;
  float ring=max(abs(length(r.xz)-1.02)-.2,abs(r.y)-.012);
  float a=uTime*.9;vec3 m=vec3(cos(a)*1.5,sin(a)*.5,sin(a)*1.5);return min(min(pl,ring),length(p-m)-.15);}
float twist(vec3 p){p.xz=rot(p.y*sin(uTime*.6)*1.8)*p.xz;return (sdBox(p,vec3(.42,.95,.42))-.06)*.55;}
float menger(vec3 p){p/=.9;float d=sdBox(p,vec3(1.)),s=1.;
  for(int m=0;m<3;m++){vec3 a=mod(p*s,2.)-1.;s*=3.;vec3 r=abs(1.-3.*abs(a));
    float c=(min(max(r.x,r.y),min(max(r.y,r.z),max(r.z,r.x)))-1.)/s;d=max(d,c);}return d*.9;}
float helix(vec3 p){p.y+=uTime*.35;vec3 q=p;q.xz=rot(q.y*2.2)*q.xz;
  float s=min(length(q.xz-vec2(.5,0.)),length(q.xz+vec2(.5,0.)))-.11;
  float y=mod(q.y,.3)-.15;float rung=max(length(vec2(q.z,y))-.04,abs(q.x)-.5);return max(min(s,rung)*.6,abs(p.y-uTime*.35)-1.25);}
float ripple(vec3 p){return (length(p)-.95+.07*sin(9.*p.y-uTime*2.4)*sin(9.*p.x+uTime*1.3)*sin(7.*p.z+uTime))*.55;}

float sd(int id,vec3 p){
  if(id==0)return knot(p);if(id==1)return blobs(p);if(id==2)return lattice(p);if(id==3)return orbit(p);
  if(id==4)return twist(p);if(id==5)return menger(p);if(id==6)return helix(p);return ripple(p);}
float map(vec3 p){
  p.xz=rot(uRot.x)*p.xz;p.yz=rot(.35+uRot.y)*p.yz;
  float a=sd(uA,p);if(uK<=0.)return a;
  // blend the two fields and swell toward a sphere mid-way so the in-between reads as liquid
  float b=sd(uB,p),bump=sin(uK*3.14159);
  return mix(mix(a,b,uK),length(p)-.85,bump*.4)*(1.-.3*bump);}
vec3 nrm(vec3 p){vec2 e=vec2(.0015,-.0015);
  return normalize(e.xyy*map(p+e.xyy)+e.yyx*map(p+e.yyx)+e.yxy*map(p+e.yxy)+e.xxx*map(p+e.xxx));}

void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/uRes.y;uv-=uOff;
  vec3 ro=vec3(0.,0.,-uDist),rd=normalize(vec3(uv,1.7));
  float t=0.,steps=0.;bool hit=false;
  for(int i=0;i<110;i++){float d=map(ro+rd*t);if(d<.0012){hit=true;break;}t+=d;steps+=1.;if(t>uDist+3.)break;}
  float s=0.;
  if(hit){
    vec3 p=ro+rd*t,n=nrm(p),L=normalize(vec3(uMouse.x*2.2,uMouse.y*2.2+.9,-1.4)),V=-rd,H=normalize(L+V);
    float dif=max(dot(n,L),0.),spec=pow(max(dot(n,H),0.),32.),rim=pow(1.-max(dot(n,V),0.),3.);
    s=clamp((.05+.8*dif+.5*spec+.18*rim)*(1.-steps/110.*.6),0.,1.);}
  gl_FragColor=vec4(vec3(s),1.);}
`

// Pass 2: full-res dithering. Pixels inside the expanding wipe use the new
// theme's palette and algorithm; a dithered shockwave ring rides the edge.
// uCA/uCB are cell sizes in pixels (for ASCII: the size of one glyph pixel).
export const DITHER = /* glsl */ `
precision highp float;
uniform sampler2D uTex;uniform vec2 uRes;
uniform int uMA;uniform int uMB;uniform float uCA;uniform float uCB;
uniform vec3 uInkA;uniform vec3 uPaperA;uniform vec3 uInkB;uniform vec3 uPaperB;
uniform vec2 uClick;uniform float uR;uniform float uG[9];

mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float b2(vec2 a){a=floor(a);return fract(a.x/2.+a.y*a.y*.75);}
float b4(vec2 a){return b2(.5*a)*.25+b2(a);}
float b8(vec2 a){return b4(.5*a)*.25+b2(a);}
float S(vec2 px){return texture2D(uTex,px/uRes).r;}
// 4x5 bitmap glyph; bit index = row*4+col, row 0 on top
float glyph(int i,vec2 q){float n=0.;for(int k=0;k<9;k++){if(k==i)n=uG[k];}
  return mod(floor(n/exp2(q.y*4.+q.x)),2.);}

float ink(int m,float c,vec2 fc,vec2 off){
  if(m==4){vec2 r=rot(.785)*fc;vec2 cell=floor(r/c)*c+c*.5;float s=S(rot(-.785)*cell+off);return step(length(r-cell),sqrt(s)*c*.72);}
  if(m==5){vec2 cs=vec2(5.,6.)*c;vec2 cell=floor(fc/cs);float s=S((cell+.5)*cs+off);vec2 q=floor((fc-cell*cs-.5*c)/c);
    if(q.x<0.||q.y<0.||q.x>3.||q.y>4.)return 0.;return glyph(int(floor(clamp(s,0.,.999)*9.)),vec2(q.x,4.-q.y));}
  vec2 cell=floor(fc/c);float s=S((cell+.5)*c+off);
  float th=m==0?b8(cell):m==1?b4(cell):m==2?b2(cell):fract(52.9829189*fract(dot(cell,vec2(.06711056,.00583715))));
  return step(th+.004,s);}

void main(){
  vec2 fc=gl_FragCoord.xy;float e=length(fc-uClick)-uR;
  float ring=1.-smoothstep(0.,28.,abs(e));
  vec2 off=normalize(fc-uClick+.001)*ring*-14.; // refract the image along the ring
  vec3 col=e<(b8(fc)-.5)*52.?mix(uPaperB,uInkB,ink(uMB,uCB,fc,off)):mix(uPaperA,uInkA,ink(uMA,uCA,fc,off));
  if(b4(floor(fc/2.))<ring*.5)col=uInkB;
  gl_FragColor=vec4(col,1.);}
`
