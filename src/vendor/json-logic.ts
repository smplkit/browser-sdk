/*
 * Vendored and reduced from json-logic-js (https://github.com/jwadhams/json-logic-js)
 * MIT License — Copyright (c) 2015 Jeremy Wadhams
 * See the NOTICE file in this package for the full license text.
 *
 * This is json-logic-js v2.0.5 gutted to exactly the operators smplkit
 * flag rules use: "==", "!=", ">", ">=", "<", "<=", "in", "var", plus the
 * lazy "and" / "or" special forms inside apply(). Every retained operator
 * implementation and the apply()/truthy()/is_logic() core are byte-for-byte
 * the upstream code (reformatted only by module wrapping) — NOT rewritten —
 * so browser-side evaluation inherits the exact coercion semantics
 * ("5" == 5 is true; "in" handles both arrays and substrings; a var path
 * with any undefined link returns the not-found default) that every
 * smplkit server SDK gets from the upstream package. Do not "improve"
 * this file; any divergence here is a silent evaluation split between
 * server and browser for the same flag.
 *
 * smplkit's "contains" operator is intentionally NOT implemented here:
 * the SDK rule builders compile `contains` to JSON Logic `in` with
 * reversed operands at build time (ADR-033), so stored rule logic never
 * carries a "contains" operation — and upstream json-logic-js (which the
 * server SDKs evaluate with) would throw "Unrecognized operation" on one,
 * causing the rule to be skipped. This file throws identically.
 */

const operations: Record<string, (this: any, ...args: any[]) => any> = {
  "==": function (a, b) {
    return a == b;
  },
  "!=": function (a, b) {
    return a != b;
  },
  ">": function (a, b) {
    return a > b;
  },
  ">=": function (a, b) {
    return a >= b;
  },
  "<": function (a, b, c) {
    return c === undefined ? a < b : a < b && b < c;
  },
  "<=": function (a, b, c) {
    return c === undefined ? a <= b : a <= b && b <= c;
  },
  in: function (a, b) {
    if (!b || typeof b.indexOf === "undefined") return false;
    return b.indexOf(a) !== -1;
  },
  var: function (this: any, a, b) {
    var not_found = b === undefined ? null : b;
    var data = this;
    if (typeof a === "undefined" || a === "" || a === null) {
      return data;
    }
    var sub_props = String(a).split(".");
    for (var i = 0; i < sub_props.length; i++) {
      if (data === null || data === undefined) {
        return not_found;
      }
      // Descending into data
      data = data[sub_props[i]];
      if (data === undefined) {
        return not_found;
      }
    }
    return data;
  },
};

export function is_logic(logic: any): boolean {
  return (
    typeof logic === "object" && // An object
    logic !== null && // but not null
    !Array.isArray(logic) && // and not an array
    Object.keys(logic).length === 1 // with exactly one key
  );
}

/*
This helper will defer to the JsonLogic spec as a tie-breaker when different
language interpreters define different behavior for the truthiness of
primitives. E.g., PHP considers empty arrays to be falsy, but Javascript
considers them to be truthy. JsonLogic, as an ecosystem, needs one
consistent answer.

Spec and rationale here: http://jsonlogic.com/truthy
*/
export function truthy(value: any): boolean {
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  return !!value;
}

export function apply(logic: any, data?: any): any {
  // Does this array contain logic? Only one way to find out.
  if (Array.isArray(logic)) {
    return logic.map(function (l) {
      return apply(l, data);
    });
  }
  // You've recursed to a primitive, stop!
  if (!is_logic(logic)) {
    return logic;
  }

  var op = Object.keys(logic)[0];
  var values = logic[op];
  var i;
  var current;

  // easy syntax for unary operators, like {"var" : "x"} instead of strict {"var" : ["x"]}
  if (!Array.isArray(values)) {
    values = [values];
  }

  // 'and' and 'or' violate the normal rule of depth-first calculating
  // consequents; each manages recursion as needed.
  if (op === "and") {
    // Return first falsy, or last
    for (i = 0; i < values.length; i += 1) {
      current = apply(values[i], data);
      if (!truthy(current)) {
        return current;
      }
    }
    return current; // Last
  } else if (op === "or") {
    // Return first truthy, or last
    for (i = 0; i < values.length; i += 1) {
      current = apply(values[i], data);
      if (truthy(current)) {
        return current;
      }
    }
    return current; // Last
  }

  // Everyone else gets immediate depth-first recursion
  values = values.map(function (val: any) {
    return apply(val, data);
  });

  // The operation is called with "data" bound to its "this" and "values"
  // passed as arguments.
  if (
    Object.prototype.hasOwnProperty.call(operations, op) &&
    typeof operations[op] === "function"
  ) {
    return operations[op].apply(data, values);
  }

  throw new Error("Unrecognized operation " + op);
}
