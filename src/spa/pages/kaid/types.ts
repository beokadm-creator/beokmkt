export interface BaseEl { id: string; x: number; y: number; width: number; height: number }

export interface ImageArea { id: string; x: number; y: number; w: number; h: number; href: string }

export interface ImageEl extends BaseEl {
  type: 'image'; src: string; href: string; opacity: number
  areas: ImageArea[]
}
export interface TextEl extends BaseEl {
  type: 'text'; content: string; fontSize: number; color: string
  bgColor: string; align: 'left' | 'center' | 'right'
  bold: boolean; italic: boolean; padding: number
  lineHeight: number; letterSpacing: number; fontFamily: string
}
export interface ButtonEl extends BaseEl {
  type: 'button'; text: string; href: string
  bgColor: string; textColor: string; borderRadius: number; fontSize: number
}
export type El = ImageEl | TextEl | ButtonEl

export interface Config { date: string; lang: 'ENG' | 'KOR'; viewOnlineUrl: string; bgColor: string }
export interface SavedImage { id: string; name: string; src: string }
export interface SavedTemplate { id: string; name: string; els: El[] }
export interface NewsletterMeta { id: string; name: string; config: Config; el_count: number; updated_at: string }
export interface NewsletterFull extends NewsletterMeta { els: El[] }
