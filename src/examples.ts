/**
 * Example usage of the Denial Constraints to SQL transpiler
 */

import { transpileDC } from './index';

console.log('='.repeat(80));
console.log('Denial Constraints to SQL Transpiler - Examples');
console.log('='.repeat(80));
console.log();

// Example 1: Unique constraint
// From the paper: Unique constraint on (EmpID, ProjID)
console.log('Example 1: Unique Constraint');
console.log('-'.repeat(80));
const dc1 = '¬(t0.hours.EmpID==t1.hours.EmpID^t0.hours.ProjID==t1.hours.ProjID)';
console.log('Input DC:');
console.log(dc1);
console.log();
console.log('Generated SQL:');
console.log(transpileDC(dc1, { includeComments: true }));
console.log();

// Example 2: Order dependency with business rule
// "Employee with more hours should not receive lower bonus"
console.log('Example 2: Order Dependency with Business Rule');
console.log('-'.repeat(80));
const dc2 = '¬(t0.hours.Role==t1.hours.Role^t0.hours.Hours>t1.hours.Hours^t0.hours.Bonus<t1.hours.Bonus)';
console.log('Input DC:');
console.log(dc2);
console.log();
console.log('Generated SQL:');
console.log(transpileDC(dc2, { includeComments: true }));
console.log();

// Example 3: Real example from DCFinder output (planets dataset)
console.log('Example 3: Complex DC from Planets Dataset');
console.log('-'.repeat(80));
const dc3 = '¬(t0.WDC_planets.csv.Rings<>t1.WDC_planets.csv.Rings^t0.WDC_planets.csv.Type==t1.WDC_planets.csv.Type)';
console.log('Input DC:');
console.log(dc3);
console.log();
console.log('Generated SQL:');
console.log(transpileDC(dc3, { includeComments: true }));
console.log();

// Example 4: Multi-predicate constraint
console.log('Example 4: Multi-Predicate Constraint');
console.log('-'.repeat(80));
const dc4 = '¬(t0.WDC_planets.csv.ConfirmedMoons>=t1.WDC_planets.csv.ConfirmedMoons^t0.WDC_planets.csv.OrbitalPeriod<=t1.WDC_planets.csv.OrbitalPeriod^t0.WDC_planets.csv.Type<>t1.WDC_planets.csv.Type)';
console.log('Input DC:');
console.log(dc4);
console.log();
console.log('Generated SQL:');
console.log(transpileDC(dc4, { includeComments: true }));
console.log();

// Example 5: Functional dependency
console.log('Example 5: Functional Dependency-like Constraint');
console.log('-'.repeat(80));
const dc5 = '¬(t0.employees.Department==t1.employees.Department^t0.employees.Manager<>t1.employees.Manager)';
console.log('Input DC:');
console.log(dc5);
console.log();
console.log('Generated SQL:');
console.log(transpileDC(dc5, { includeComments: true }));
console.log();

// Example 6: Compact format (no formatting)
console.log('Example 6: Compact SQL Output');
console.log('-'.repeat(80));
const dc6 = '¬(t0.airport.Country==t1.airport.Country^t0.airport.Timezone<>t1.airport.Timezone)';
console.log('Input DC:');
console.log(dc6);
console.log();
console.log('Generated SQL (compact):');
console.log(transpileDC(dc6, { formatOutput: false }));
console.log();

console.log('='.repeat(80));
console.log('All examples completed successfully!');
console.log('='.repeat(80));

