package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Inspection;

abstract class Base implements Inspection {
  private final String id, area, severity;

  Base(String area, String id, String severity) {
    this.area = area;
    this.id = id;
    this.severity = severity;
  }

  @Override
  public String id() {
    return id;
  }

  @Override
  public String area() {
    return area;
  }

  @Override
  public String severity() {
    return severity;
  }
}
