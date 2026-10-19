import './globals.css';
import { Barlow_Condensed, Inter } from 'next/font/google';

const display = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-display',
});
const body = Inter({ subsets: ['latin'], variable: '--font-body' });

export const metadata = {
  title: 'Liga Pro | Gestión de Cancha',
  description: 'Tabla general, jornadas, tarjetas y suspensiones de tu liga.',
};

export const viewport = { themeColor: '#05080f' };

export default function RootLayout({ children }) {
  return (
    <html lang="es" className={`${display.variable} ${body.variable}`}>
      <body className="bg-night-950 font-sans text-slate-100 antialiased">{children}</body>
    </html>
  );
}
