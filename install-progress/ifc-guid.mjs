// The IFC GlobalId Revit exports for an element, from its UniqueId (the Viewer's externalId), so a wall in an IFC model
// can be found from the APS model and back without a lookup table. Revit's export GUID is the UniqueId's episode GUID
// with its last 32 bits XOR the element id (the UniqueId's last 8 hex digits); IFC writes the 128 bits as 22 characters
// of its own base 64 (the first carries 2 bits, the other 21 carry 6 each). Checked against a Revit 2022 IFC2x3 export.

const IFC64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const UNIQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}$/i;

// "0515e905-8d0d-428b-9460-f10e9a7eaf68-0157bde7" -> "055Ua5ZGr2YvHWyGwRAHAF"; null when it isn't a Revit UniqueId.
export function revitIfcGuid(uniqueId) {
    const id = String(uniqueId || '').trim();
    if (!UNIQUE_ID.test(id)) return null;
    const episode = id.slice(0, 36).replace(/-/g, ''), element = parseInt(id.slice(37), 16);
    const last = (parseInt(episode.slice(24), 16) ^ element) >>> 0;
    return compressGuid(episode.slice(0, 24) + last.toString(16).padStart(8, '0'));
}

// 32 hex digits -> the 22-character IFC GlobalId.
export function compressGuid(hex) {
    let bits = '0000';
    for (let i = 0; i < 32; i += 2) bits += parseInt(hex.slice(i, i + 2), 16).toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i < 132; i += 6) out += IFC64[parseInt(bits.slice(i, i + 6), 2)];
    return out;
}
