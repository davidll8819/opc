export type Models = { text:string; search:string; image:string; video:string }
export const emptyModels = ():Models => ({text:'',search:'',image:'',video:''})
export const modelLabels:Record<keyof Models,string>={text:'文字模型',search:'联网搜索模型',image:'图片模型',video:'视频模型'}
