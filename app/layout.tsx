import type {Metadata} from 'next';
import './globals.css';
import 'leaflet/dist/leaflet.css';
export const metadata:Metadata={title:'길이음 | 배리어프리 길찾기',description:'거리의 실제 모습을 확인하고, 나에게 맞는 길을 찾아요.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ko"><body>{children}</body></html>;}
