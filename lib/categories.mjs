// Overture's place taxonomy (taxonomy.primary, taxonomy.hierarchy) → the OpenMapTiles "class" the Glimpse map
// already draws (frontend/src/components/map/poiIcons.ts) and the API turns into a venue badge group
// (VenueCategories.FromMapClass): restaurant, fast_food → food; cafe → coffee; bakery, ice_cream → sweet;
// bar, beer → drinks. Anything not listed is left out of the map. Only places people go to eat or drink, where
// they take photos (owner's decision 13/11/2026); counts are of the 2026-10-21 release, confidence ≥ 0.7.

export const CLASSES = {
  cafe: [
    'cafe', 'coffee_shop', 'tea_room', 'bubble_tea_shop', 'coffee_roastery', 'smoothie_juice_bar', 'milk_bar',
    'kombucha_bar', 'hong_kong_style_cafe', 'dog_cafe', 'cat_cafe', 'animal_cafe',
  ],
  bakery: ['bakery', 'donut_shop', 'cupcake_shop', 'bagel_shop', 'pie_shop', 'pretzel_shop', 'macaron_shop'],
  ice_cream: [
    'ice_cream_shop', 'gelato_shop', 'frozen_yogurt_shop', 'dessert_shop', 'shaved_ice_shop', 'candy_store',
    'chocolatier', 'japanese_confectionery_shop', 'indian_sweets_shop',
  ],
  fast_food: ['fast_food_restaurant', 'sandwich_shop', 'food_truck_stand', 'food_court', 'friterie', 'flatbread_shop', 'canteen', 'delicatessen'],
  beer: ['brewery', 'beer_bar', 'beer_garden', 'cidery'],
  bar: [
    'bar', 'pub', 'cocktail_bar', 'lounge', 'wine_bar', 'sports_bar', 'sake_bar', 'hookah_bar', 'irish_pub', 'dive_bar',
    'gay_bar', 'hotel_bar', 'speakeasy', 'whiskey_bar', 'tiki_bar', 'bar_tabac', 'cigar_bar', 'beach_bar',
    'champagne_bar', 'piano_bar', 'gastropub', 'tapas_bar', 'vermouth_bar',
  ],
  // Every kind of restaurant (taxonomy.hierarchy[2] = 'restaurant') and the few eateries without a finer kind.
  restaurant: ['diner', 'bistro', 'fondue_restaurant', 'food_and_drink'],
}

const list = (values) => values.map((v) => `'${v}'`).join(', ')

export const CLASS_SQL = `CASE
  ${Object.entries(CLASSES)
    .map(([cls, primaries]) => `WHEN taxonomy.primary IN (${list(primaries)}) THEN '${cls}'`)
    .join('\n  ')}
  WHEN taxonomy.hierarchy[1] = 'food_and_drink' AND taxonomy.hierarchy[2] = 'restaurant' THEN 'restaurant'
  ELSE NULL END`
