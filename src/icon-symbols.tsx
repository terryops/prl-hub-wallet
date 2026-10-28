// Ionicons 8.1.0, Copyright (c) 2015-present Ionic, MIT licensed; license: public/licenses/ionicons.txt.
// The wallet reuses the Web set (ICONS.md) and adds only the shapes it needs; no SF Symbols.
import { iconSymbols as web } from "../shared/icon-symbols.tsx";
export const iconSymbols = {
  ...web,
  // A plain hexagon (not from Ionicons): the NOCK mark, like the native app's hexagon badge, so NOCK
  // never passes for the PRL pearl.
  hexagon: <path d="M256 40 443 148v216L256 472 69 364V148Z" />,
  // add-circle-outline.svg
  create: <><path d="M448 256c0-106-86-192-192-192S64 150 64 256s86 192 192 192 192-86 192-192Z" fill="none" stroke="currentColor" strokeMiterlimit="10" strokeWidth="32px" /><path d="M256 176v160M336 256H176" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32px" /></>,
  // download-outline.svg
  restore: <><path d="M336 176h40a40 40 0 0 1 40 40v208a40 40 0 0 1-40 40H136a40 40 0 0 1-40-40V216a40 40 0 0 1 40-40h40" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32px" /><path d="m176 272 80 80 80-80M256 48v288" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32px" /></>,
  // key-outline.svg
  backup: <><path d="M218.1 167.17c0 13 0 25.6 4.1 37.4-43.1 50.6-156.9 184.3-167.5 194.5a20.17 20.17 0 0 0-6.7 15c0 8.5 5.2 16.7 9.6 21.3 6.6 6.9 34.8 33 40 28 15.4-15 18.5-19 24.8-25.2 9.5-9.3-1-28.3 2.3-36s6.8-9.2 12.5-10.4 15.8 2.9 23.7 3c8.3.1 12.8-3.4 19-9.2 5-4.6 8.6-8.9 8.7-15.6.2-9-12.8-20.9-3.1-30.4s23.7 6.2 34 5 22.8-15.5 24.1-21.6-11.7-21.8-9.7-30.7c.7-3 6.8-10 11.4-11s25 6.9 29.6 5.9c5.6-1.2 12.1-7.1 17.4-10.4 15.5 6.7 29.6 9.4 47.7 9.4 68.5 0 124-53.4 124-119.2S408.5 48 340 48s-121.9 53.37-121.9 119.17ZM400 144a32 32 0 1 1-32-32 32 32 0 0 1 32 32Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="32px" /></>,
  // eye-outline.svg: a read-only wallet (iOS "eye")
  eye: <><path d="M255.66 112c-77.94 0-157.89 45.11-220.83 135.33a16 16 0 0 0-.27 17.77C82.92 340.8 161.8 400 255.66 400c92.84 0 173.34-59.38 221.79-135.25a16.14 16.14 0 0 0 0-17.47C428.89 172.28 347.8 112 255.66 112Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32" /><circle cx="256" cy="256" r="80" fill="none" stroke="currentColor" strokeMiterlimit="10" strokeWidth="32" /></>,
  // options-outline.svg
  options: <><path d="M368 128h80M64 128h240M368 384h80M64 384h240M208 256h240M64 256h80" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32px" /><circle cx="336" cy="128" r="32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32px" /><circle cx="176" cy="256" r="32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32px" /><circle cx="336" cy="384" r="32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32px" /></>,
};
export type IconName = keyof typeof iconSymbols;
