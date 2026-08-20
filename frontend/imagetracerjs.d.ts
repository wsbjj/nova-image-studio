// imagetracerjs 1.2.6 没有随包提供类型；这里只声明本项目实际用到的部分。
// 上游 imagetoslice 把同一版本 vendor 进仓库（src/vendor/imagetracer.js），
// 我们改为走 npm 依赖，避免 1200 行第三方代码进版本库。
declare module 'imagetracerjs' {
  /** imagedataToSVG 的追踪参数。语义见包内 options.md。 */
  export interface ImageTracerOptions {
    /** 直线拟合容差，越小越贴合原图 */
    ltres?: number;
    /** 曲线拟合容差 */
    qtres?: number;
    /** 丢弃短于该长度的路径，用于去噪点 */
    pathomit?: number;
    rightangleenhance?: boolean;
    /** 0=无 1=随机 2=确定性采样 */
    colorsampling?: 0 | 1 | 2;
    numberofcolors?: number;
    mincolorratio?: number;
    colorquantcycles?: number;
    /** 0=stacked 1=parallel */
    layering?: 0 | 1;
    strokewidth?: number;
    linefilter?: boolean;
    /** 输出坐标缩放系数 */
    scale?: number;
    roundcoords?: number;
    /** 是否输出 viewBox 属性 */
    viewbox?: boolean;
    /** 是否输出 desc 调试属性 */
    desc?: boolean;
    blurradius?: number;
    blurdelta?: number;
  }

  export interface ImageTracer {
    /** 把 ImageData 追踪为 SVG 源码字符串。 */
    imagedataToSVG(imageData: ImageData, options?: ImageTracerOptions | string): string;
  }

  const tracer: ImageTracer;
  export default tracer;
}
