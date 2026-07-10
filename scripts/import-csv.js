/**
 * CSV Import Script
 * Usage: node scripts/import-csv.js path/to/file.csv
 * 
 * Reads a CSV file and imports all flood points into MongoDB.
 * Run this after setting up .env with MONGODB_URI.
 */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';

dotenv.config();

async function main() {
  const filePath = process.argv[2];
  
  if (!filePath) {
    console.error('\n  Usage: node scripts/import-csv.js <path-to-csv>\n');
    console.error('  Example: node scripts/import-csv.js ~/Downloads/FLOODS2017TO2025.csv\n');
    process.exit(1);
  }

  console.log('\n  Reading file:', filePath);
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error('  ❌ Could not read file:', e.message);
    process.exit(1);
  }

  console.log('  File size:', (text.length / 1024 / 1024).toFixed(2), 'MB');

  // Connect to DB
  const { connectDB } = await import('../server/db.js');
  try {
    await connectDB();
  } catch (e) {
    console.error('  ❌ Cannot connect to MongoDB. Check MONGODB_URI in .env');
    process.exit(1);
  }

  // Import via API logic
  console.log('  Importing to database...\n');
  
  const start = Date.now();
  
  let httpResponse;
  let serverUnreachable = false;
  try {
    httpResponse = await fetch(`http://localhost:${process.env.PORT || 8000}/api/import/csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    // Genuine network error (e.g. ECONNREFUSED) — server isn't running.
    serverUnreachable = true;
  }

  if (!serverUnreachable) {
    if (!httpResponse.ok) {
      // The server IS running and responded with a real error (bad CSV,
      // no coordinate columns, etc). Surface it — don't silently fall
      // back to a different import path that would mask the problem.
      const errBody = await httpResponse.json().catch(() => ({}));
      console.error('\n  ❌ Import failed:', errBody.error || httpResponse.statusText, '\n');
      process.exit(1);
    }

    const result = await httpResponse.json();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log('  ✅ Import complete in ' + elapsed + 's\n');
    console.log('  Total points:  ', result.totalPoints.toLocaleString());
    console.log('  Flooded:       ', result.floodedPoints.toLocaleString());
    console.log('  Never flooded: ', result.neverFlooded.toLocaleString());
    console.log('  Flood events:  ', result.eventCount);
    console.log('  Mode:          ', result.mode);
    console.log('\n  Data is now in MongoDB and ready to use!\n');
  } else {
    // Direct import (server not running)
    console.log('  Server not running, importing directly...\n');
    
    const { FloodPoint } = await import('../server/models/FloodPoint.js');
    const { Dataset } = await import('../server/models/Dataset.js');
    
    // Parse CSV inline
    const lines = text.split('\n').filter(l => l.trim());
    let headerIdx = 0;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      if (lines[i].split(',').length >= 3) { headerIdx = i; break; }
    }
    
    function parseLine(line) {
      const result = []; let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
        else { if (c === '"') inQ = true; else if (c === ',') { result.push(cur); cur = ''; } else cur += c; }
      }
      result.push(cur); return result;
    }
    
    const header = parseLine(lines[headerIdx]);
    const body = lines.slice(headerIdx + 1).map(parseLine);
    
    const norm = h => h.toLowerCase().trim();
    let lonI = -1, latI = -1;
    header.forEach((h, i) => {
      const n = norm(h);
      if (lonI < 0 && ['x','lon','lng','longitude','long'].includes(n)) lonI = i;
      if (latI < 0 && ['y','lat','latitude'].includes(n)) latI = i;
    });
    if (latI < 0) latI = header.length - 2;
    if (lonI < 0) lonI = header.length - 1;
    
    const evI = [];
    header.forEach((h, i) => {
      if (i === latI || i === lonI) return;
      if (/(?:^|_)(19|20)\d{2}/.test(h) || /flood/i.test(h)) evI.push(i);
    });
    
    const FM = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const SM = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function pretty(name) {
      const m = name.match(/(January|February|March|April|May|June|July|August|September|October|November|December)_(\d{4})/i);
      if (m) return SM[FM.indexOf(m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase())] + ' ' + m[2];
      return name.replace(/^.*?Flood_/i, '').replace(/_/g, ' ');
    }
    
    // Clear old data
    await FloodPoint.deleteMany({});
    await Dataset.deleteMany({});
    
    const BATCH = 5000;
    let batch = [], total = 0, flooded = 0;
    const evCounts = new Array(evI.length).fill(0);
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    
    for (const r of body) {
      const lat = parseFloat(r[latI]), lng = parseFloat(r[lonI]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
      
      const flags = evI.map(i => parseInt((r[i] || '0').trim()) === 1);
      const freq = flags.reduce((a, b) => a + (b ? 1 : 0), 0);
      flags.forEach((b, i) => { if (b) evCounts[i]++; });
      if (freq > 0) flooded++;
      
      batch.push({ fid: total + 1, lat, lng, freq, flags, events: evI.map(i => header[i]) });
      total++;
      
      if (batch.length >= BATCH) {
        process.stdout.write('\r  Imported ' + total.toLocaleString() + ' points...');
        await FloodPoint.insertMany(batch, { ordered: false });
        batch = [];
      }
    }
    if (batch.length) await FloodPoint.insertMany(batch, { ordered: false });
    
    await Dataset.create({
      name: 'Vijayawada Floods',
      mode: 'flood',
      totalPoints: total,
      floodedPoints: flooded,
      neverFlooded: total - flooded,
      eventCount: evI.length,
      eventNames: evI.map(i => pretty(header[i])),
      eventCounts: evCounts,
      latRange: [minLat, maxLat],
      lngRange: [minLng, maxLng],
    });
    
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log('\r  ✅ Import complete in ' + elapsed + 's                    \n');
    console.log('  Total points:  ', total.toLocaleString());
    console.log('  Flooded:       ', flooded.toLocaleString());
    console.log('  Never flooded: ', (total - flooded).toLocaleString());
    console.log('  Flood events:  ', evI.length);
    console.log('\n  Data is now in MongoDB!\n');
  }
  
  process.exit(0);
}

main().catch(err => { console.error('\n  ❌ Error:', err.message, '\n'); process.exit(1); });
