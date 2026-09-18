package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.Block;
import org.eclipse.jdt.core.dom.BooleanLiteral;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.Expression;
import org.eclipse.jdt.core.dom.IfStatement;
import org.eclipse.jdt.core.dom.ParenthesizedExpression;
import org.eclipse.jdt.core.dom.PrefixExpression;
import org.eclipse.jdt.core.dom.ReturnStatement;
import org.eclipse.jdt.core.dom.Statement;

/** `if (c) return true; else return false;` → `return c;` (and the negated form). */
public final class IfReturnBoolean extends Base {
  public IfReturnBoolean() {
    super("style", "ifReturnBoolean", "info");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(IfStatement s) {
        Boolean then = literalReturn(s.getThenStatement());
        Boolean els = literalReturn(s.getElseStatement());
        if (then == null || els == null || then.equals(els)) return true;
        out.add(new Finding(IfReturnBoolean.this, s, "if/else returning boolean literals: return the condition", "Replace with 'return " + (then ? "" : "!") + s.getExpression() + ";'", rw -> {
          AST ast = s.getAST();
          Expression cond = (Expression) rw.createCopyTarget(s.getExpression());
          ReturnStatement r = ast.newReturnStatement();
          if (then) r.setExpression(cond);
          else {
            PrefixExpression not = ast.newPrefixExpression();
            not.setOperator(PrefixExpression.Operator.NOT);
            ParenthesizedExpression p = ast.newParenthesizedExpression();
            p.setExpression(cond);
            not.setOperand(p);
            r.setExpression(not);
          }
          rw.replace(s, r, null);
        }));
        return true;
      }
    });
  }

  private static Boolean literalReturn(Statement s) {
    if (s instanceof Block b && b.statements().size() == 1) s = (Statement) b.statements().get(0);
    return s instanceof ReturnStatement r && r.getExpression() instanceof BooleanLiteral l ? l.booleanValue() : null;
  }
}
