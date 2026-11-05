import qrcode from 'qrcode-generator';

// The guide's QR points at the site's home page, wherever it is hosted.
const home = new URL('./', location.href).href;
const q = qrcode(0, 'M'); q.addData(home); q.make();
document.getElementById('qr')!.innerHTML = q.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
document.getElementById('url')!.textContent = home.replace(/^https?:\/\//, '').replace(/\/$/, '');
